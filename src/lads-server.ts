/**
 *
 * Copyright (c) 2023 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 * Copyright (c) 2023 SPECTARIS - Deutscher Industrieverband für optische, medizinische und mechatronische Technologien e.V. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { join } from "path"
import assert from "assert";
import {
    ApplicationType,
    BaseNode,
    CallMethodResultOptions,
    DataType,
    DataValue,
    LocalizedText,
    OPCUAServer,
    ObjectTypeIds,
    ReferenceTypeIds,
    SessionContext,
    StatusCode,
    StatusCodes,
    UAObject,
    UAStateMachineEx,
    Variant,
    VariantArrayType,
    VariantLike,
    coerceNodeId,
    promoteToStateMachine
} from "node-opcua"
import { UADevice } from "node-opcua-nodeset-di"

import {
    LADSDeviceHelper,
    getLADSObjectType,
    sleepMilliSeconds,
    stateAborted,
    stateAborting,
    stateRunning,
    stateStopped,
    stateStopping
} from "./lads-utils"

import {
    LADSAnalogArraySensorFunction,
    LADSAnalogControlFunction,
    LADSCoverFunction,
    LADSDevice,
    LADSFunctionalUnit,
    LADSResult,
} from "./lads-interfaces"

// At which level is the workshop currently
const workshopStep = 10;

//---------------------------------------------------------------
// main
//---------------------------------------------------------------
(async () => {
    //---------------------------------------------------------------
    // Step 1: load the required OPC UA nodesets and start the server
    //---------------------------------------------------------------
    // provide paths for the nodeset files
    const nodeset_path = join(__dirname, '../nodesets')
    const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
    const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
    const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
    const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
    const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
    const nodeset_luminescencereader = join(nodeset_path, 'LuminescenceReader.xml')

    try {
        // build the server object
        const uri = "LADS-SampleServer"
        const server = new OPCUAServer({
            port: 26543,
            // basic information about the server
            buildInfo: {
                manufacturerName: "SPECTARIS",
                productUri: uri,
                softwareVersion: "1.0.0",
            },
            serverInfo: {
                applicationName: "LADS LuminescenceReader",
                applicationType: ApplicationType.Server,
                productUri: uri,
                applicationUri: uri,

            },
            // nodesets used by the server
            nodeset_filename: [
                nodeset_standard,
                nodeset_di,
                nodeset_machinery,
                nodeset_amb,
                nodeset_lads,
                nodeset_luminescencereader,
            ]
        })

        // start the server
        await server.start();
        const endpoint = server.endpoints[0].endpointDescriptions()[0].endpointUrl;
        console.log("Step 1: server is ready on ", endpoint);
        console.log("CTRL+C to stop");

        // stop here if we only want to show step 1
        if (workshopStep < 2) return;

        //---------------------------------------------------------------
        // Step 2: search for devices availabe in the server's DeviceSet
        // DeviceSet is defined by OPC UA Device Integration and represents the collection of devices in a server
        //---------------------------------------------------------------
        assert(server.engine.addressSpace)
        const addressSpace = server.engine.addressSpace

        // The devideSet Node instance is created by the DI Nodeset and is stable. Thats why we can use this ID
        // directly in its namespace to get directly to the node
        const deviceSetNodeID = 5001

        // To get the node instance we get a reference to the namespace it is located in and use the Node ID from above to find it
        const nameSpaceDI = addressSpace.getNamespace('http://opcfoundation.org/UA/DI/')
        const deviceSet = <UAObject>addressSpace.findNode(coerceNodeId(deviceSetNodeID, nameSpaceDI.index))
        assert(deviceSet)

        // To list all devices in the deviceSet we check for nodes that are referenced by references of type `Aggregates`
        const deviceReferences = deviceSet.findReferencesExAsObject(coerceNodeId(ReferenceTypeIds.Aggregates))
        const devices = deviceReferences.map((device) => <UADevice>device )

        devices.forEach((device: UADevice) => {
            console.log(`Step 2: Found device ${device.browseName} of type ${device.typeDefinitionObj.browseName}`)
        })

        // stop here if we only want to show step 2
        if (workshopStep < 3) return

        //---------------------------------------------------------------
        // Step 3: access the device as LuminescenseReader
        //---------------------------------------------------------------
        // first step: define an interface to conveniently access and bind the OPC UA objects
        interface LuminescenceReaderFunctionalUnit extends LADSFunctionalUnit {
            functionSet: {
                luminescenceSensor: LADSAnalogArraySensorFunction
                temperatureController: LADSAnalogControlFunction
                injector1: LADSAnalogControlFunction
                injector2: LADSAnalogControlFunction
                injector3: LADSAnalogControlFunction
                cover: LADSCoverFunction
            }
        }

        interface LuminescenceReaderDevice extends LADSDevice {
            functionalUnitSet: {
                luminescenceReaderUnit: LuminescenceReaderFunctionalUnit
            }
        }

        // second step: find device with matching type and cast to interface
        const luminescenceReaderDevice = <LuminescenceReaderDevice>devices.find(
            (device) => (device.typeDefinitionObj.browseName.name?.includes('Luminescence')))

        // alternative pragmatic way completley omitting step 2: if the node-id is known directly access device object
        const luminescenceDeviceID = 5011
        const nameSpaceLR = addressSpace.getNamespace('http://spectaris.de/LuminescenceReader/')
        const _luminescenceReaderDevice = <LuminescenceReaderDevice>addressSpace.findNode(coerceNodeId(luminescenceDeviceID, nameSpaceLR.index))

        console.log(`Step 3: Found Device with browseName: ${luminescenceReaderDevice.browseName.name}`)

        // stop here if we only want to show step 3
        if (workshopStep < 4) return

        //---------------------------------------------------------------
        // Step 4: set OPC UA variable values from internal variables (use case: read values from the device)
        //---------------------------------------------------------------
        // first step: get selected LADS OPC UA objects using interface definition
        const functionalUnit = luminescenceReaderDevice.functionalUnitSet.luminescenceReaderUnit
        const functionSet = functionalUnit.functionSet

        // luminescence sensor
        const luminescenceSensor = functionSet.luminescenceSensor
        const wells = 96

        // temperature controller
        const temperatureController = functionSet.temperatureController
        let targetTemperature = 37.0
        let currentTemperature = 25.0
        let temperatureControllerIsOn = true
        const damping = 0.8

        // second step: periodically calulate values and update their OPC UA peer variables
        const verbose = false
        const interval = verbose?5:1
        setInterval(() => {
            // temperature with 1st order low pass filter and noise
            const temperature = temperatureControllerIsOn ? targetTemperature : 25
            currentTemperature = damping * currentTemperature + (1 - damping) * temperature
            const currentTemperatureWithNoise = currentTemperature + 0.2 * (Math.random() - 0.5)

            // array of luminescence readings with some noise
            const luminescenceWithNoise = new Float64Array(wells).map((_, index) => index * index + (Math.random() - 0.5) )

            // use the setValueFromSource() function to update the variables in the OPC UA information model
            temperatureController.currentValue.setValueFromSource({ dataType: DataType.Double, value: currentTemperatureWithNoise })
            luminescenceSensor.sensorValue.setValueFromSource({ dataType: DataType.Double, arrayType: VariantArrayType.Array, value: luminescenceWithNoise })

            if (verbose) console.log(`Step 4: ${(new Date()).toISOString()} - setting temperature to ${currentTemperatureWithNoise.toFixed(2)} and luminescence to ${luminescenceWithNoise[0].toFixed(2)}, ${luminescenceWithNoise[1].toFixed(2)},... (${luminescenceWithNoise.length} values)`);
        }, 1000 * interval /* seconsds */)
        console.log(`Step 4: setting temperature and luminescence values in a ${interval} second interval`)

        // stop here if we only want to show step 4
        if (workshopStep < 5) return

        //---------------------------------------------------------------
        // Step 5: get value changes from OPC UA variables (use case: write values to the device)
        //---------------------------------------------------------------
        const targetValue = temperatureController.targetValue
        const validateVariableValue = true
        if (!validateVariableValue) {
            // simply bind a (anonymous) function to OPC UA variable changes
            targetValue.on("value_changed", (dataValue) => { targetTemperature = dataValue.value.value })
        } else {
            // Get the range for the supplied value from the targetValue that was populated by the nodeset file
            const range = targetValue.euRange.readValue().value.value
            // bind a setter / getter to the variable, do validations and return status-code
            targetValue.bindVariable({
                set: (variantValue: Variant): StatusCode => {
                    const value: number = variantValue.value

                    if (range && ((value > range.high) || (value < range.low))) {
                        // value clamped to euRange
                        const clampedValue = (value > range.high) ? range.high : range.low
                        targetTemperature = clampedValue
                        console.log(`Step 5: Clamped set variable to ${targetTemperature}`);
                        return StatusCodes.GoodClamped
                    } else {
                        // value within euRange
                        targetTemperature = value
                        console.log(`Step 5: Set variable to ${targetTemperature} without clamping`);
                        return StatusCodes.Good
                    }
                },
                get: (): Variant => { return new Variant({ dataType: DataType.Double, value: targetTemperature }) }
            })
        }

        // stop here if we only want to show step 5
        if (workshopStep < 6) return

        //---------------------------------------------------------------
        // Step 6: provide value history for interal variables (depends on tech stack)
        //---------------------------------------------------------------
        const variable = temperatureController.currentValue
        variable.historizing = true
        addressSpace.installHistoricalDataNode(variable)
        console.log(`Step 6: enabled history on temperature value`);

        // stop here if we only want to show step 6
        if (workshopStep < 7) return

        //---------------------------------------------------------------
        // Step 7: utilize OPC UA state-machines and its methods
        //---------------------------------------------------------------
        // first step "promoting" the state machine (this depends on the tech/stacks capabilities)
        const temperatureControllerStateMachine = promoteToStateMachine(temperatureController.stateMachine)
        temperatureControllerStateMachine.setState('Stopped')
        console.log(`Step 7: initialized state machine to "Stopped"`);

        // callback functions associated to OPC UA method calls
        async function onStartTemperatureController(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            if (inputArguments.length > 0) {
                targetTemperature = inputArguments[0].value
                temperatureController.targetValue.setValueFromSource({value: targetTemperature, dataType: DataType.Double})
            }
            this.setState("Running")
            console.log("Step 7: changed state machine to Running");
            return { statusCode: StatusCodes.Good }
        }

        async function onStopTemperatureController(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            this.setState("Stopping")
            console.log("Step 7: changed state machine to Stopping");

            sleepMilliSeconds(1000).then(() => {
                this.setState("Stopped")
                console.log("Step 7: changed state machine to Stopped");
            })
            return { statusCode: StatusCodes.Good }
        }

        // second step: bind functions for starting and stopping to OPC UA methods
        temperatureController.stateMachine.start.bindMethod(onStartTemperatureController.bind(temperatureControllerStateMachine))
        temperatureController.stateMachine.startWithTargetValue?.bindMethod(onStartTemperatureController.bind(temperatureControllerStateMachine))
        temperatureController.stateMachine.stop.bindMethod(onStopTemperatureController.bind(temperatureControllerStateMachine))

        // third step: bind internal state variable to OPC UA stateMachine.currentState variable
        temperatureController.stateMachine.currentState.on("value_changed", (dataValue: DataValue) => {
            const state = (<LocalizedText>dataValue.value.value).text
            temperatureControllerIsOn = state ? state.includes("Running") : false
        })

        // stop here if we only want to show step 7
        if (workshopStep < 8) return

        //---------------------------------------------------------------
        // Step 8: generate OPC UA events on selected state changes (use case: Audit trails)
        //---------------------------------------------------------------
        // get the most basic OPC UA event type (there are many more & you can define your own event types)
        const baseEventType = addressSpace.findEventType(coerceNodeId(ObjectTypeIds.BaseEventType))
        assert(baseEventType)

        // raise event whenever the state of the temperature-controller statemachine has changed
        temperatureController.stateMachine.currentState.on("value_changed", (dataValue: DataValue) => {
            const message = `${temperatureController.getDisplayName()} state changed to "${(<LocalizedText>dataValue.value.value).text}".`
            temperatureController.raiseEvent(baseEventType, { message: { dataType: DataType.LocalizedText, value: message } })
            console.log("Step 8: raised state-changed event");
        })

        // raise event whenever the target-value of the temperature-controller has changed
        temperatureController.targetValue.on("value_changed", (dataValue: DataValue) => {
            const message = `${temperatureController.getDisplayName()} value changed to "${dataValue.value.value.toString()}".`
            temperatureController.raiseEvent(baseEventType, { message: { dataType: DataType.LocalizedText, value: message } })
            console.log("Step 8: raised value-changed event");
        })

        // stop here if we only want to show step 8
        if (workshopStep < 9) return

        //---------------------------------------------------------------
        // Step 9: Running programs and generating results (dynamic creation of LADS OPC UA objects)
        //---------------------------------------------------------------
        const activeProgram = functionalUnit.programManager.activeProgram
        const resultSet = functionalUnit.programManager.resultSet
        const functionalUnitStateMachine = promoteToStateMachine(functionalUnit.stateMachine)
        functionalUnitStateMachine.setState("Stopped")
        let runId = 0

        async function runProgram(deviceProgramRunId: string, inputArguments: VariantLike[]) {
            // dynamically create an new result object in the result set
            const resultType = getLADSObjectType(addressSpace, "ResultType")
            const result = <LADSResult>resultType.instantiate({ componentOf: <BaseNode><unknown>resultSet, browseName: deviceProgramRunId })

            // get program template-id
            const programTemplateId: string = inputArguments[0].value

            // set context information provided by input-arguments
            result.properties?.setValueFromSource(inputArguments[1])
            result.supervisoryJobId?.setValueFromSource(inputArguments[2])
            result.supervisoryTaskId?.setValueFromSource(inputArguments[3])
            result.samples?.setValueFromSource(inputArguments[4])
            result.started?.setValueFromSource({ dataType: DataType.DateTime, value: new Date() })

            // initialize active-program runtime properties
            const runTime = 30000 //ms
            const delta = 500 //ms
            activeProgram.currentRuntime?.setValueFromSource({ dataType: DataType.Double, value: 0 })
            activeProgram.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: 'Measure' })
            activeProgram.currentStepNumber?.setValueFromSource({ dataType: DataType.UInt32, value: 1 })
            activeProgram.currentStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: 0 })
            activeProgram.estimatedRuntime?.setValueFromSource({ dataType: DataType.Double, value: runTime })
            activeProgram.deviceProgramRunId?.setValueFromSource({ dataType: DataType.String, value: deviceProgramRunId })

            // start all required functions
            functionalUnitStateMachine.setState(stateRunning)
            temperatureControllerStateMachine.setState(stateRunning)
            for (let t = 0; t <= runTime; t += delta) {
                // update active-program runtime properties
                activeProgram.currentRuntime?.setValueFromSource({ dataType: DataType.Double, value: t })
                activeProgram.currentStepRuntime?.setValueFromSource({ dataType: DataType.Double, value: t })

                // do whatever is necessary for the run
                await sleepMilliSeconds(delta)

                // check if run was stopped or aborted from remote
                const currentState  = functionalUnitStateMachine.getCurrentState()
                if (currentState) {
                    if ([stateStopping, stateStopped, stateAborting, stateAborted].some( (state) => {currentState.includes(state)})) {
                        break
                    }
                }
            }
            temperatureControllerStateMachine.setState(stateStopped)
            functionalUnitStateMachine.setState(stateStopped)

            // finalize
            result.stopped?.setValueFromSource({ dataType: DataType.DateTime, value: new Date() })
            activeProgram.currentStepName?.setValueFromSource({ dataType: DataType.LocalizedText, value: 'Finished' })
            activeProgram.currentStepNumber?.setValueFromSource({ dataType: DataType.UInt32, value: 2 })

            // get luminescence readings and add to VariableSet in result
            const readings = luminescenceSensor.sensorValue.readValue()
            result.namespace.addVariable({
                propertyOf: result.variableSet,
                browseName: 'Luminescence',
                dataType: DataType.Double,
                valueRank: 1,
                arrayDimensions: [wells],
                value: readings.value
            })
        }

        async function startProgram(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            // validate current state
            const currentState = this.getCurrentState();
            if (!(currentState && (currentState.includes(stateStopped) || currentState.includes(stateAborted)))) {
                return { statusCode: StatusCodes.BadInvalidState }
            }

            // valdate input arguments
            for (const inputArgumentIndex in inputArguments) {
                const inputArgument = inputArguments[inputArgumentIndex];
                // TODO validate argument at position index
                const validationFailed = false
                if (validationFailed) return { statusCode: StatusCodes.BadInvalidArgument }
            }

            // initiate program run (async)
            const deviceProgramRunId = `Run-${++runId}`
            runProgram(deviceProgramRunId, inputArguments)

            // return run-Id
            return {
                outputArguments: [new Variant({ dataType: DataType.String, value: deviceProgramRunId })],
                statusCode: StatusCodes.Good
            }
        }

        async function stopProgram(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            return stopOrAbortProgram(this, stateStopping, stateStopped)
        }

        async function abortProgram(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            return stopOrAbortProgram(this, stateAborting, stateAborted)
        }

        async function stopOrAbortProgram(stateMachine: UAStateMachineEx, transitiveState: string, finalState: string) {
            const currentState = stateMachine.getCurrentState();
            if (!(currentState && currentState.includes(stateRunning))) return { statusCode: StatusCodes.BadInvalidState }
            stateMachine.setState(transitiveState)
            sleepMilliSeconds(1000).then(() => stateMachine.setState(finalState))
            return { statusCode: StatusCodes.Good }
        }

        functionalUnit.stateMachine.startProgram?.bindMethod(startProgram.bind(functionalUnitStateMachine))
        functionalUnit.stateMachine.stop?.bindMethod(stopProgram.bind(functionalUnitStateMachine))
        functionalUnit.stateMachine.abort?.bindMethod(abortProgram.bind(functionalUnitStateMachine))

        // stop here if we only want to show step 9
        if (workshopStep < 10) return
        const deviceHelper = new LADSDeviceHelper(luminescenceReaderDevice, {initializationTime: 2000, shutdownTime: 2000})

    } catch (err) {
        console.log(err);
        process.exit(-1);
    }
})()
