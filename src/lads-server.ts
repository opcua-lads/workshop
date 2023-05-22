import { BaseNode, CallMethodResultOptions, DataType, DataValue, LocalizedText, OPCUAServer, ObjectTypeIds, SessionContext, StatusCodes, UAObject, UAStateMachineEx, Variant, VariantArrayType, VariantLike, coerceNodeId, promoteToStateMachine } from "node-opcua"
import { UADevice } from "node-opcua-nodeset-di"
import {LADSAnalogArraySensorFunction, LADSAnalogControlFunction, LADSCoverFunction, LADSDevice, LADSFunctionalUnit, LADSResult, getDevices, getLADSObjectType, sleepMilliSeconds} from "./lads-utils"
import {join } from "path"

//---------------------------------------------------------------
// Step 3: define an interface to conveniently access and bind the OPC UA objects
//---------------------------------------------------------------
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

//---------------------------------------------------------------
// main
//---------------------------------------------------------------
(async () => {
    //---------------------------------------------------------------
    // Step 1: load the required OPC UA nodesets and start the server
    //---------------------------------------------------------------
    // provide paths for the nodeset files
    //const nodeset_path = './src/workshop/luminescencereader/nodesets'
    const nodeset_path = join(__dirname, '../nodesets')
    const nodeset_standard = join(nodeset_path, 'Opc.Ua.NodeSet2.xml')
    const nodeset_di = join(nodeset_path, 'Opc.Ua.DI.NodeSet2.xml')
    const nodeset_amb = join(nodeset_path, 'Opc.Ua.AMB.NodeSet2.xml')
    const nodeset_machinery = join(nodeset_path, 'Opc.Ua.Machinery.NodeSet2.xml')
    const nodeset_lads = join(nodeset_path, 'Opc.Ua.LADS.NodeSet2.xml')
    const nodeset_luminescencereader = join(nodeset_path, 'LuminescenceReader.xml')
    try {
        // build the server object
        const server = new OPCUAServer({
            port: 26543, buildInfo: {
                manufacturerName: "SPECTARIS",
                productUri: "",
                softwareVersion: "1.0.0",
            },
            serverInfo: {
                applicationName: "LADS LuminescenceReader",
            },
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
        const endpoint = server.endpoints[0].endpointDescriptions()[0].endpointUrl; console.log(" server is ready on ", endpoint);
        console.log("CTRL+C to stop");

        //---------------------------------------------------------------
        // Step 2: search for devices availabe in the server's DeviceSet
        // DeviceSet is defined by OPC UA Device Integration and represents the collection of devices in a server
        //---------------------------------------------------------------
        const addressSpace = server.engine.addressSpace
        const devices = getDevices(addressSpace)
        devices.forEach((device: UADevice) => {
            console.log(`Found device ${device.browseName} of type ${device.typeDefinitionObj.browseName}`)
        })
        
        //---------------------------------------------------------------
        // Step 3: access the device as LuminescenseReader
        //---------------------------------------------------------------
        // fast track: with fixed node-id
        const luminescenceReaderDeviceByNodeId = <LuminescenceReaderDevice>addressSpace.findNode(coerceNodeId(5023, 6))
        // save track: find device with matching type 
        const luminescenceReaderDevice = <LuminescenceReaderDevice>devices.find((device) => (device.typeDefinitionObj.browseName.name.includes('Luminescence')))

        //---------------------------------------------------------------
        // Step 4A: set OPC UA variable values from internal variables (use case: read values from the device)
        //---------------------------------------------------------------
        // get selected LADS OPC UA objects
        const functionaUnit = luminescenceReaderDevice.functionalUnitSet.luminescenceReaderUnit
        const functionSet = functionaUnit.functionSet
        // luminescence sensor
        const luminescenceSensor = functionSet.luminescenceSensor
        const wells = 96
        // temperature controller
        const temperatureController = functionSet.temperatureController
        let targetTemperature = 37.0
        let currentTemperature = 25.0
        let temperatureControllerIsOn = true
        const damping = 0.8

        // execute periodically
        setInterval(() => {
            // generate some simulated values (e.g., from device-software/firmware)
            currentTemperature  = damping * currentTemperature + (1 - damping) * (temperatureControllerIsOn?targetTemperature:25)
            const luminescence = new Float64Array(wells) .map((_, index) => {return index * index + (Math.random() - 0.5)})
            // use the setValueFromSource() function to upfate the variables in the OPC UA information model
            temperatureController.currentValue.setValueFromSource({dataType: DataType.Double, value: currentTemperature + 0.2 * (Math.random() - 0.5)})
            luminescenceSensor.sensorValue.setValueFromSource({ dataType: DataType.Double, arrayType: VariantArrayType.Array, value: luminescence })
        }, 1000)

        //---------------------------------------------------------------
        // Step 4B: provide value history for interal variables (depends on stack)
        //---------------------------------------------------------------
        const variable = temperatureController.currentValue
        variable.historizing = true
        addressSpace.installHistoricalDataNode(variable)

        //---------------------------------------------------------------
        // Step 5: get value changes from OPC UA varibales (use case: write values to the device)
        //---------------------------------------------------------------
        // simply bind a function to OPC UA variable changes
        temperatureController.targetValue.on("value_changed", (dataValue) => {targetTemperature = dataValue.value.value})
        
        //---------------------------------------------------------------
        // Step 6: utilize OPC UA state-machines and its methods
        //---------------------------------------------------------------
        // first step "promoting" the state machine (this depends on the tech/stacks capabilities)
        const temperatureControllerStateMachine = promoteToStateMachine(temperatureController.stateMachine)
        temperatureControllerStateMachine.setState('Stopped')
        // second step: bind functions for starting and stopping to OPC UA methods
        temperatureController.stateMachine.start.bindMethod(onStartTemperatureController.bind(temperatureControllerStateMachine))
        temperatureController.stateMachine.stop.bindMethod(onStopTemperatureController.bind(temperatureControllerStateMachine))
        // third step: bind internal state variable to OPC UA stateMachine.currentState variable
        temperatureController.stateMachine.currentState.on("value_changed", (dataValue: DataValue) => {
            const state = (<LocalizedText>dataValue.value.value).text
            temperatureControllerIsOn = (state.toLowerCase().includes("running"))
        })
        //---------------------------------------------------------------
        // callback functions associated to OPC UA method calls
        //---------------------------------------------------------------
        async function onStartTemperatureController(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            this.setState("Running")
            return { statusCode: StatusCodes.Good }
        }
        async function onStopTemperatureController(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            this.setState("Stopping")
            sleepMilliSeconds(1000).then(() => this.setState("Stopped"))
            return { statusCode: StatusCodes.Good }
        }

        //---------------------------------------------------------------
        // Step 7: generate OPC UA events on selected state changes (use case: Audit trails)
        //---------------------------------------------------------------
        temperatureController.stateMachine.currentState.on("value_changed", (dataValue: DataValue) => { raiseEventOnChange(temperatureController, dataValue)})
        temperatureController.targetValue.on("value_changed", (dataValue: DataValue) => { raiseEventOnChange(temperatureController, dataValue)})

        function raiseEventOnChange(source: UAObject, dataValue: DataValue) {
            const baseEventType = addressSpace.findEventType(coerceNodeId(ObjectTypeIds.BaseEventType))
            const value = dataValue.value.value
            const isStateChange = dataValue.value.dataType === DataType.LocalizedText
            const message = isStateChange?`${source.getDisplayName()} changed state to "${(<LocalizedText>value).text}".`:`${source.getDisplayName()} value changed to "${value.toString()}".`
            source.raiseEvent(baseEventType, { message: {dataType: DataType.LocalizedText, value: message}})
        }

        //---------------------------------------------------------------
        // Step 8: Running programs and generating results (dynamic creation of LADS OPC UA objects)
        //---------------------------------------------------------------
        const activeProgram = functionaUnit.programManager.activeProgram
        const resultSet = functionaUnit.programManager.resultSet
        const functionalUnitStateMachine  = promoteToStateMachine(functionaUnit.stateMachine)
        let runId = 0
        functionalUnitStateMachine.setState("Stopped")
        functionaUnit.stateMachine.startProgram.bindMethod(startProgram.bind(functionalUnitStateMachine))

        async function startProgram(this: UAStateMachineEx, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
            if (this.getCurrentState().includes("Stopped")) {
                const deviceProgramRunId = `Run-${++runId}`
                runProgram(deviceProgramRunId, inputArguments)
                return { 
                    outputArguments: [new Variant({dataType: DataType.String, value: deviceProgramRunId})],
                    statusCode: StatusCodes.Good 
                };
            } else {
                return { statusCode: StatusCodes.BadInvalidState };
            }
        }

        async function runProgram(deviceProgramRunId: string, inputArguments: VariantLike[]) {
            functionalUnitStateMachine.setState("Running")
            temperatureControllerStateMachine.setState("Running")
            // create an new entry in result set
            const resultType = getLADSObjectType(addressSpace, "ResultType")
            const result = <LADSResult>resultType.instantiate({ componentOf: <BaseNode><unknown>resultSet, browseName: deviceProgramRunId })
            const started = new Date()
            result.started?.setValueFromSource({dataType: DataType.DateTime, value: started})
            // start measurements
            const runTime = 30000 //ms
            const delta = 500 //ms
            activeProgram.currentRuntime?.setValueFromSource({dataType: DataType.Double, value: 0})
            activeProgram.currentStepName?.setValueFromSource({dataType: DataType.LocalizedText, value: 'Measure'})
            activeProgram.currentStepNumber?.setValueFromSource({dataType: DataType.UInt32, value: 1})
            activeProgram.currentStepRuntime?.setValueFromSource({dataType: DataType.Double, value: 0})
            activeProgram.estimatedRuntime?.setValueFromSource({dataType: DataType.Double, value: runTime})
            activeProgram.deviceProgramRunId?.setValueFromSource({dataType: DataType.String, value: deviceProgramRunId})
            // run 
            for (let t = 0; t <= runTime; t+=delta) {
                activeProgram.currentRuntime?.setValueFromSource({dataType: DataType.Double, value: t})
                activeProgram.currentStepRuntime?.setValueFromSource({dataType: DataType.Double, value: t})
                await sleepMilliSeconds(delta)
            }
            // finalize
            result.stopped?.setValueFromSource({dataType: DataType.DateTime, value: new Date()})
            activeProgram.currentStepName?.setValueFromSource({dataType: DataType.LocalizedText, value: 'Finished'})
            activeProgram.currentStepNumber?.setValueFromSource({dataType: DataType.UInt32, value: 2})
            // get luminescence readings and add to VariableSet in result
            const readings = luminescenceSensor.sensorValue.readValue()
            result.namespace.addVariable({
                propertyOf: result.variableSet,
                browseName: 'Luminescence',
                dataType: DataType.Double,
                valueRank: 1,
                arrayDimensions: [96],
                value: readings.value
            })
            temperatureControllerStateMachine.setState("Stopped")
            functionalUnitStateMachine.setState("Stopped")
        }


    } catch (err) {
        console.log(err);
        process.exit(-1);
    }
})()