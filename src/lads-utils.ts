/**
 *
 * Copyright (c) 2023 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 * Copyright (c) 2023 SPECTARIS - Deutscher Industrieverband für optische, medizinische und mechatronische Technologien e.V. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from "assert"

import {
    CallMethodResultOptions,
    DataType,
    DataValueT,
    IAddressSpace,
    INamespace,
    LocalizedText,
    NodeClass,
    ObjectTypeIds,
    ReferenceTypeIds,
    SessionContext,
    StatusCodes,
    UAObject,
    UAObjectType,
    UAStateMachineEx,
    VariantLike,
    coerceNodeId,
    promoteToStateMachine
} from "node-opcua"
import { 
    LADSDevice, 
    LADSFunction, 
    LADSFunctionalUnit 
} from "./lads-interfaces"
import { EnumDeviceHealth } from "node-opcua-nodeset-di"

//---------------------------------------------------------------
// Convenience functions
//---------------------------------------------------------------
export async function sleepMilliSeconds(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

export function getLADSNamespace(addressSpace: IAddressSpace): INamespace {
    return addressSpace.getNamespace('http://opcfoundation.org/UA/LADS/')
}

export function getMachineryNamespace(addressSpace: IAddressSpace): INamespace {
    return addressSpace.getNamespace('http://opcfoundation.org/UA/Machinery/')
}

export function getLADSObjectType(addressSpace: IAddressSpace, objectType: string): UAObjectType {
    const namespace = getLADSNamespace(addressSpace)
    assert(namespace)

    const objectTypeNode = namespace.findObjectType(objectType)
    assert(objectTypeNode)

    return objectTypeNode
}

export function getLADSFunctionalUnits(device: LADSDevice): LADSFunctionalUnit[] {
    const functionalUnits: LADSFunctionalUnit[] = []
    if (!device) return functionalUnits
    const addressSpace = device.addressSpace
    const functionalUnitSet = <UAObject><unknown>device.functionalUnitSet
    const functionalUnitType = getLADSObjectType(addressSpace, "FunctionalUnitType")
    const hierarchicalReferencesType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HierarchicalReferences))
    assert(hierarchicalReferencesType)
    const nodes = functionalUnitSet.findReferencesExAsObject(hierarchicalReferencesType)
    nodes.forEach((node: UAObject) => {
        if (node.nodeClass === NodeClass.Object) {
            if (node.typeDefinitionObj.isSubtypeOf(functionalUnitType)) {
                const functionalUnit = <LADSFunctionalUnit>node
                functionalUnits.push(functionalUnit)
            }
        }
    })
    return functionalUnits
}

export function getLADSFunctions(parent: LADSFunctionalUnit | LADSFunction, recursive = false, addHasNotifierReferences = false): LADSFunction[] {
    const functions: LADSFunction[] = []
    if (!parent) return functions
    if (!parent.functionSet) return functions
    const addressSpace = parent.addressSpace
    const functionSet = <UAObject><unknown>parent.functionSet
    const functionType = getLADSObjectType(addressSpace, "FunctionType")
    const hierarchicalReferencesType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HierarchicalReferences))
    const hasNotifierType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasNotifier))
    assert(hierarchicalReferencesType)
    assert(hasNotifierType)
    parent.addReference({referenceType: hasNotifierType, nodeId:functionSet.nodeId})
    parent.setEventNotifier(1)
    functionSet.setEventNotifier(1)
    const nodes = functionSet.findReferencesExAsObject(hierarchicalReferencesType)
    const notifierReferences = parent.findReferencesAsObject(hasNotifierType)
    nodes.forEach((node: UAObject) => {
        if (node.nodeClass === NodeClass.Object) {
            if (node.typeDefinitionObj.isSubtypeOf(functionType)) {
                const ladsFunction = <LADSFunction>node
                if (addHasNotifierReferences) {
                    if (!(notifierReferences.includes(ladsFunction))) {
                        ladsFunction.setEventNotifier(1)
                        functionSet.addReference({referenceType: hasNotifierType, nodeId:ladsFunction})
                    }
                }
                functions.push(ladsFunction)
                if (recursive) {
                    const childFunctions = getLADSFunctions(ladsFunction, true)
                    functions.concat(childFunctions)
                }
            }
        }
    })
    return functions
}


//---------------------------------------------------------------
// buildLADSEventNotifierTree()
//
// Utility function to build a tree of HasNotifier references: 
// - The device including including all its functional-units via the functional-unit-set, 
// - For each functional-unit all underlying functions in a recursive way via the function-set 
// All mentioned objects will be marked as EventNotifier.
// This allows a client to subscribe to events within a sub-tree scope:
// - subscribing to a device includes all events of its functional-units and functions
// - subscribiing to a functional-unit includes events of all underlying functions
// - subscribing to a function includes events of all underlying functions
//---------------------------------------------------------------

export function buildLADSEventNotifierTree(device: LADSDevice) { 
    if (!device) return
    const addressSpace = device.addressSpace
    const hasNotifierType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasNotifier))
    assert(hasNotifierType)
    const functionalUnitSet = <UAObject><unknown>device.functionalUnitSet
    const functionalUnits = getLADSFunctionalUnits(device)
    const notifierReferences = device.findReferencesAsObject(hasNotifierType)
    device.addReference({referenceType: hasNotifierType, nodeId:functionalUnitSet.nodeId})
    device.setEventNotifier(1)
    functionalUnitSet.setEventNotifier(1)
    functionalUnits.forEach((functionalUnit) => {
        if (!notifierReferences.includes(functionalUnit)) {
            functionalUnit.setEventNotifier(1)            
            functionalUnitSet.addReference({referenceType: hasNotifierType, nodeId:functionalUnit})
        }
        const ladsFunctions = getLADSFunctions(functionalUnit, true, true)
    })
}

//---------------------------------------------------------------
// LADSDeviceHelper class
//
// Helper object to provide several features for a device object:
// - automatically add an Organizes reference to the device within the Machines folder
// - automatically add HasEvent references to the device sub-tree as decribed above
// - example implmentation of state-machine logic and behavior as 
//   described in Annex B of LADS OPC UA 30500-1
// - optionally raise events whenever one of the state-machine states changes
//---------------------------------------------------------------

// LADSDeviceStateMachine
const stateDeviceInitialization = 'Initialization'
const stateDeviceOperate = 'Operate'
const stateDeviceSleep = 'Sleep'
const stateDeviceShutdown = 'Shutdown'

// MachineryItemState
const stateMachineryItemNotAvailable = 'NotAvailable'
const stateMachineryItemExecuting = 'Executing'
const stateMachineryItemNotExecuting = 'NotExecuting'
const stateMachineryItemOutOfService = 'OutOfService'

// MachineryOperationMode
const stateOperationModeNone = 'None'
const stateOperationModeProcessing ='Processing'
const stateOperationModeMaintenance = 'Maintenance'
const stateOperationModeSetup = 'Setup'

// FunctionalStateMachine
export const stateClearing = 'Clearing'
export const stateRunning = 'Running'
export const stateStopping = 'Stopping'
export const stateStopped = 'Stopped'
export const stateAborting = 'Aborting'
export const stateAborted = 'Aborted'

export interface LADSDeviceHelperOptions {
    initializationTime?: number
    shutdownTime?: number
    raiseEvents?: boolean
}

export class LADSDeviceHelper {
    static eventType: UAObjectType
    device: LADSDevice
    options: LADSDeviceHelperOptions
    deviceStateMachine: UAStateMachineEx
    machineryItemState?: UAStateMachineEx
    machineryOperationMode?: UAStateMachineEx
    functionalUnitStateMachines: UAStateMachineEx[] = []

    constructor(device: LADSDevice, options: LADSDeviceHelperOptions = {}) {
        this.device = device
        this.options = options
        const addressSpace = device.addressSpace

        // prepare event bubble up propagation
        buildLADSEventNotifierTree(device)
        
        // find event type
        if (!LADSDeviceHelper.eventType) {
            const eventType = addressSpace.findEventType(coerceNodeId(ObjectTypeIds.BaseEventType))
            assert(eventType)
            LADSDeviceHelper.eventType = eventType
        }

        // provide link to device in machines folder
        const organizesType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.Organizes))
        assert(organizesType)
        const machineryNamespaceIndex= getMachineryNamespace(addressSpace).index
        const machinesFolder = addressSpace.findNode(coerceNodeId(1001, machineryNamespaceIndex))
        machinesFolder?.addReference({referenceType: organizesType, nodeId: device.nodeId})

        // get and promote state-machines
        this.deviceStateMachine = promoteToStateMachine(device.stateMachine)
        this.machineryItemState = device.machineryItemState?promoteToStateMachine(device.machineryItemState):undefined
        this.machineryOperationMode = device.machineryOperationMode?promoteToStateMachine(device.machineryOperationMode):undefined
        const functionalUnits = getLADSFunctionalUnits(device)
        functionalUnits.forEach((functionalUnit) => {
            const functionalUnitStateMachine = promoteToStateMachine(functionalUnit.stateMachine)
            functionalUnitStateMachine.currentState.on('value_changed', this.onFunctionalUnitStateChanged.bind(this, functionalUnit, functionalUnitStateMachine))
            this.functionalUnitStateMachines.push(functionalUnitStateMachine)
        })

        // bind state changes
        device.stateMachine.currentState.on('value_changed', this.onDeviceStateChanged.bind(this))
        device.machineryItemState?.currentState.on('value_changed', this.onMachineryItemStateChanged.bind(this))
        device.machineryOperationMode?.currentState.on('value_changed', this.onMachineryOperationModeChanged.bind(this))
        device.deviceHealth?.on('value_changed', this.onDeviceHealthChanged.bind(this))

        // bind methods
        device.stateMachine.gotoOperate?.bindMethod(this.onGotoOperating.bind(this))
        device.stateMachine.gotoSleep?.bindMethod(this.onGotoSleep.bind(this))
        device.stateMachine.gotoShutdown?.bindMethod(this.onGotoShutdown.bind(this))
        device.machineryOperationMode?.gotoMaintenance?.bindMethod(this.onGotoOperationMode.bind(this, stateOperationModeMaintenance))
        device.machineryOperationMode?.gotoProcessing?.bindMethod(this.onGotoOperationMode.bind(this, stateOperationModeProcessing))
        device.machineryOperationMode?.gotoSetup?.bindMethod(this.onGotoOperationMode.bind(this, stateOperationModeSetup))

        // initialize device
        this.enterDeviceInitialzation()
    }

    raiseEvent(message: string) {
        if (!this.options.raiseEvents) return
        this.device.raiseEvent(LADSDeviceHelper.eventType, { message: { dataType: DataType.LocalizedText, value:`${this.device.getDisplayName()} ${message}`} })
    }

    async onGotoOperating(this: LADSDeviceHelper, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.enterDeviceOperating()
        return {statusCode: StatusCodes.Good}
    }

    async onGotoSleep(this: LADSDeviceHelper, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.enterDeviceSleep()
        return {statusCode: StatusCodes.Good}
    }

    async onGotoShutdown(this: LADSDeviceHelper, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.enterDeviceShutdown()
        return {statusCode: StatusCodes.Good}
    }

    async onGotoOperationMode(this: LADSDeviceHelper, operationMode: string, inputArguments: VariantLike[], context: SessionContext): Promise<CallMethodResultOptions> {
        this.machineryOperationMode?.setState(operationMode)
        return {statusCode: StatusCodes.Good}
    }

    enterDeviceInitialzation() {
        this.deviceStateMachine.setState(stateDeviceInitialization)
        this.machineryOperationMode?.setState(stateOperationModeNone)
        sleepMilliSeconds(this.options?.initializationTime?this.options.initializationTime:50).then(() => this.enterDeviceOperating())
    }

    enterDeviceOperating() {
        const state = state2str(this.deviceStateMachine.getCurrentState())
        if (state.includes(stateDeviceOperate)) return
        this.deviceStateMachine.setState(stateDeviceOperate)
        this.machineryOperationMode?.setState(stateOperationModeProcessing)
    }

    enterDeviceSleep() {
        this.deviceStateMachine.setState(stateDeviceSleep)
    }

    enterDeviceShutdown() {
        this.deviceStateMachine.setState(stateDeviceShutdown)
        this.machineryOperationMode?.setState(stateOperationModeNone)
        sleepMilliSeconds(this.options?.shutdownTime?this.options.shutdownTime:1000).then(() => { this.enterDeviceInitialzation() })
    }

    async onDeviceStateChanged(dataValue: DataValueT<LocalizedText, DataType.LocalizedText>){ 
        const state = dataValue.value.value.text
        if (!state) return
        this.raiseEvent(`state changed to ${state} .. `)
        if (!state.includes(stateDeviceOperate)) {
            this.machineryItemState?.setState(stateMachineryItemNotAvailable)
        }
    }

    async onDeviceHealthChanged(dataValue: DataValueT<EnumDeviceHealth, DataType.UInt32>) { 
        const value = dataValue.value.value
        const key = Object.keys(EnumDeviceHealth)[Object.values(EnumDeviceHealth).indexOf(value)]
        this.raiseEvent(`health changed to ${key} .. `)
        if (value == EnumDeviceHealth.FAILURE) {
            this.machineryItemState?.setState(stateMachineryItemOutOfService)
            this.functionalUnitStateMachines.forEach((stateMachine) => {
                if (state2str(stateMachine.getCurrentState()).includes(stateRunning)) {
                    stateMachine.setState(stateAborting)
                    sleepMilliSeconds(1000).then(() => stateMachine.setState(stateAborted))
                }
            })
        }
    }

    async onMachineryOperationModeChanged(dataValue: DataValueT<LocalizedText, DataType.LocalizedText>){ 
        const state = dataValue.value.value.text
        if (!state) return
        this.raiseEvent(`operation mode changed to ${state} .. `)
    }

    async onMachineryItemStateChanged(dataValue: DataValueT<LocalizedText, DataType.LocalizedText>){ 
        const state = dataValue.value.value.text
        if (!state) return
        this.raiseEvent(`item state changed to ${state} .. `)
    }

    async onFunctionalUnitStateChanged(functionalUnit: LADSFunctionalUnit, stateMachine: UAStateMachineEx, dataValue: DataValueT<LocalizedText, DataType.LocalizedText>) { 
        const state = dataValue.value.value.text
        if (!state) return
        this.raiseEvent(`${functionalUnit.getDisplayName()} state changed to ${state} ..`)
        sleepMilliSeconds(50).then(() => {
            const functionalUnitStates = this.functionalUnitStateMachines.map((stateMachine => (state2str(stateMachine.getCurrentState()))))
            const functionalUnitsRunnning = functionalUnitStates.reduce((count, state) => { return state.includes(stateRunning)?count +1:count }, 0)    
            this.machineryItemState?.setState(functionalUnitsRunnning>0?stateMachineryItemExecuting:stateMachineryItemNotExecuting)
        })        
    }
}

function state2str(value: string | null) {return value?value:''}
