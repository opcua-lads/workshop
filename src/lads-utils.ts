/**
 *
 * Copyright (c) 2023 - 2024 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
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
    promoteToStateMachine,
    ExtensionObject, 
    NodeId,
    UAFiniteStateMachine,
    UAState,
    BaseNode,
    sameNodeId,
    ObjectIds,
    makeNodeId,
    NodeIdLike,
    UAVariable,
    UAAliasNameCategory} from "node-opcua"
import { 
    LADSDevice, 
    LADSDeviceState, 
    LADSFunction, 
    LADSBaseControlFunction,
    LADSFunctionalState, 
    MachineryItemState, 
    MachineryOperationMode,
    LADSAnalogScalarSensorFunction,
    LADSAnalogControlFunction,
    LADSCoverFunction,
    LADSAnalogControlFunctionWithTotalizer,
    LADSFunctionalUnit} from "./lads-interfaces"
import { EnumDeviceHealth } from "node-opcua-nodeset-di"

export enum DIObjectIds {
    deviceSet = 5001
}

//---------------------------------------------------------------
// Convenience functions
//---------------------------------------------------------------
export async function sleepMilliSeconds(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

export function getProperty<T>(property: T | null, propertyName: string): T {
    if (!property) {
        throw new Error(`Failed to get ${propertyName}`);
    }
    return property as T
}

export function getLADSNamespace(addressSpace: IAddressSpace): INamespace {
    return addressSpace.getNamespace('http://opcfoundation.org/UA/LADS/')
}

export function getAMBNamespace(addressSpace: IAddressSpace): INamespace {
    return addressSpace.getNamespace('http://opcfoundation.org/UA/AMB/')
}

export function getMachineryNamespace(addressSpace: IAddressSpace): INamespace {
    return addressSpace.getNamespace('http://opcfoundation.org/UA/Machinery/')
}

export function constructNameNodeIdExtensionObject(addressSpace: IAddressSpace, name: string, nodeId: NodeId): ExtensionObject {
    const ns = getAMBNamespace(addressSpace)
    const dt = addressSpace.findDataType("NameNodeIdDataType", ns.index)
    assert(dt)
    const result = addressSpace.constructExtensionObject(dt, { Name: name, NodeId: nodeId})
    return result
}

export function getLADSObjectType(addressSpace: IAddressSpace, objectType: string): UAObjectType {
    const namespace = getLADSNamespace(addressSpace)
    assert(namespace)

    const objectTypeNode = namespace.findObjectType(objectType)
    assert(objectTypeNode)

    return objectTypeNode
}

export function getLADSNode(addressSpace: IAddressSpace, id: number): BaseNode | null {
    const namespace = getLADSNamespace(addressSpace)
    return namespace.findNode(makeNodeId(id, namespace.index))
}

export function getChildObjects(parent: UAObject): UAObject[] {
    const children: UAObject[] = []
    if (!parent) return children
    const addressSpace = parent.addressSpace
    const hasChildReferencesType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasChild))
    assert(hasChildReferencesType)
    const nodes = parent.findReferencesExAsObject(hasChildReferencesType)
    nodes.forEach((node: UAObject) => {
        if (node.nodeClass === NodeClass.Object) {
            children.push(node)
        }
    })
    return children
}

export function getLADSFunctionalUnits(device: LADSDevice): LADSFunctionalUnit[] {
    const functionalUnits: LADSFunctionalUnit[] = []
    if (!device) return functionalUnits
    const addressSpace = device.addressSpace
    const functionalUnitSet = <UAObject><unknown>device.functionalUnitSet
    const functionalUnitType = getLADSObjectType(addressSpace, "FunctionalUnitType")
    const hasChildReferencesType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasChild))
    assert(hasChildReferencesType)
    const nodes = functionalUnitSet.findReferencesExAsObject(hasChildReferencesType)
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
    //const notifierFlags = EventNotifierFlags.SubscribeToEvents
    const notifierFlags = 1
    const addressSpace = parent.addressSpace
    const functionSet = <UAObject><unknown>parent.functionSet
    const functionType = getLADSObjectType(addressSpace, "FunctionType")
    const hasChildReferencesType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasChild))
    const hasNotifierType = addressSpace.findReferenceType(coerceNodeId(ReferenceTypeIds.HasNotifier))
    assert(hasChildReferencesType)
    assert(hasNotifierType)
    if (addHasNotifierReferences) {
        parent.addReference({referenceType: hasNotifierType, nodeId:functionSet.nodeId})
        parent.setEventNotifier(notifierFlags)
        functionSet.setEventNotifier(notifierFlags)
    }
    const nodes = functionSet.findReferencesExAsObject(hasChildReferencesType)
    const notifierReferences = parent.findReferencesAsObject(hasNotifierType)
    nodes.forEach((node: UAObject) => {
        if (node.nodeClass === NodeClass.Object) {
            if (node.typeDefinitionObj.isSubtypeOf(functionType)) {
                const ladsFunction = <LADSFunction>node
                if (addHasNotifierReferences) {
                    if (!(notifierReferences.includes(ladsFunction))) {
                        ladsFunction.setEventNotifier(notifierFlags)
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

export interface LADSKeyVariable {key: string, variable: UAVariable}
export function getLADSSupportedProperties(functionalUnit: LADSFunctionalUnit): LADSKeyVariable[] {
    const result: LADSKeyVariable[] = []
    const supportedPropertiesSet = functionalUnit?.supportedPropertiesSet
    if (supportedPropertiesSet) {
        const organizesType = functionalUnit.addressSpace.findReferenceType(ReferenceTypeIds.Organizes)
        const properties =  getChildObjects(<UAObject><unknown>supportedPropertiesSet)
        properties.forEach((property) => {
            const key = property.browseName.name
            const references = property.findReferencesAsObject(organizesType)
            if (references.length > 0) {
                const variable = references[0] as UAVariable
                result.push({key: key, variable: variable})
            }
        })
    }
    return result
}

//---------------------------------------------------------------
// Aliases support
//---------------------------------------------------------------


//---------------------------------------------------------------
// Aliases support
//---------------------------------------------------------------

export function getAliasName(node: BaseNode): string {
    const nodes = getParents(node, DIObjectIds.deviceSet)
    const names = nodes.map((node) => {
        const name = node.browseName.name
        return name?name:"unknown"
    })
    const filteredNames = names.filter((name) => (!(["DeviceSet", "FunctionalUnitSet", "FunctionSet", "Components", "TaskSet", 
    "DeviceState", "FunctionalUnitState", "ProgramManager", "ControlFunctionState", "CoverState", "unknown"].includes(name))))
    return filteredNames.join("_")
}

export function getParents(node: BaseNode, rootNodeId: NodeIdLike = ObjectIds.ObjectsFolder): BaseNode[] {
    const rootNode = rootNodeId instanceof NodeId?rootNodeId:makeNodeId(rootNodeId)
    if (sameNodeId(node.nodeId, rootNode))
        return [node]
    const parentNodeId = node.parentNodeId
    if (parentNodeId) {
        try {
            const parent = node.addressSpace.findNode(parentNodeId)
            assert(parent)
            const parents = getParents(parent)
            parents.push(node)
            return parents
        }
        catch(error) {
            console.log(error)
            return [node]
        }
    } else {
        return [node]
    }
}

function addTagVariable(variable: UAVariable | null | undefined) {
    if (!variable) return
    const addressSpace = variable.addressSpace
    const tagVariables = <UAAliasNameCategory>addressSpace.findNode(coerceNodeId(ObjectIds.TagVariables))
    const aliasNameType = addressSpace.findObjectType(coerceNodeId(ObjectTypeIds.AliasNameType))
    const aliasName = getAliasName(variable)
    const tagVariable = aliasNameType?.instantiate({
        browseName: aliasName,
        description: `Tag name of variable ${aliasName}.`,
        organizedBy: tagVariables,
    })
    const aliasFor = tagVariable?.addReference({
        referenceType: coerceNodeId(ReferenceTypeIds.AliasFor),
        nodeId: variable.nodeId
    })
}

export function addAliases(device: LADSDevice) {
    addDeviceAliases(device)
    const functionalUnits = getLADSFunctionalUnits(device)
    functionalUnits.forEach((functionalUnit: LADSFunctionalUnit) => {
        addFunctionalUnitAliases(functionalUnit)
        addFunctionsAliases(getLADSFunctions(functionalUnit))
    })
}

function addDeviceAliases(device: LADSDevice) {
    addTagVariable(device.deviceState.currentState)
    addTagVariable(device.deviceHealth)
    addTagVariable(device.machineryItemState?.currentState)
    addTagVariable(device.machineryOperationMode?.currentState)
    addTagVariable(device.operationCounters?.operationCycleCounter)
    addTagVariable(device.operationCounters?.operationDuration)
    addTagVariable(device.operationCounters?.powerOnDuration)
}

function addFunctionalUnitAliases(functionalUnit: LADSFunctionalUnit) {
    addTagVariable(functionalUnit.functionalUnitState.currentState)
    const programManager = functionalUnit.programManager
    if (programManager) {
        const activeProgram = programManager.activeProgram
        addTagVariable(activeProgram.currentPauseTime)
        addTagVariable(activeProgram.currentProgramTemplate)
        addTagVariable(activeProgram.currentRuntime)
        addTagVariable(activeProgram.currentStepName)
        addTagVariable(activeProgram.currentStepNumber)
        addTagVariable(activeProgram.currentStepRuntime)
        addTagVariable(activeProgram.estimatedRuntime)
        addTagVariable(activeProgram.estimatedStepNumbers)
        addTagVariable(activeProgram.estimatedStepRuntime)
    }
}

function addFunctionsAliases(functions: LADSFunction[]) {
    if (!functions) return
    functions.forEach( (ladsFunction: LADSFunction) => {
        addTagVariable((<LADSAnalogScalarSensorFunction>ladsFunction).sensorValue)
        addTagVariable((<LADSBaseControlFunction>ladsFunction).controlFunctionState?.currentState)
        addTagVariable((<LADSAnalogControlFunction>ladsFunction).targetValue)
        addTagVariable((<LADSAnalogControlFunction>ladsFunction).currentValue)
        addTagVariable((<LADSAnalogControlFunctionWithTotalizer>ladsFunction).totalizedValue)
        addTagVariable((<LADSCoverFunction>ladsFunction).coverState?.currentState)
        addFunctionsAliases(getLADSFunctions(ladsFunction))
    })
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
// - automatically add HasEventNotifier references to the device sub-tree as decribed above
// - example implementation of state-machine logic and behavior as 
//   described in Annex B of LADS OPC UA 30500-1
// - optionally raise events whenever one of the state-machine states changes
//---------------------------------------------------------------

export function promoteToFiniteStateMachine(stateMachine: UAFiniteStateMachine): UAStateMachineEx {
    const helper = new LADSFiniteStateMachineHelper(stateMachine)
    return helper.stateMachine
}

export class LADSFiniteStateMachineHelper {
    stateMachine: UAStateMachineEx
    parentStateMachineHelper?: LADSFiniteStateMachineHelper

    constructor(stateMachine: UAFiniteStateMachine, parentStateMachineHelper?: LADSFiniteStateMachineHelper) {
        this.stateMachine = promoteToStateMachine(stateMachine)
        this.stateMachine.currentState.on("value_changed", this.onCurrentStateChanged.bind(this))
        this.parentStateMachineHelper = parentStateMachineHelper
    }
    
    setEffectiveDisplayName(states: UAState[]) {
        const effectiveDisplayName = this.stateMachine.currentState.effectiveDisplayName
        if (effectiveDisplayName) {
            const names = states.map((state) => state.displayName[0].text)
            const name = names.join(".")
            effectiveDisplayName.setValueFromSource({dataType: DataType.LocalizedText, value: name})
        }
        if (this.parentStateMachineHelper) {
            const parentState = this.parentStateMachineHelper.stateMachine.currentStateNode
            if (parentState) {
                states.unshift(parentState)
                this.parentStateMachineHelper.setEffectiveDisplayName(states)
            }
        }
    }

    async onCurrentStateChanged(dataValue: DataValueT<LocalizedText, DataType.LocalizedText>) {
        const stateName = dataValue.value.value.text
        assert(stateName)
        const states = this.stateMachine.getStates()
        const state = states.find((value: UAState) => (stateName?.includes(value.browseName.name?value.browseName.name:"")))
        if(state) {
            console.log(stateName, state.browseName.name)
            this.stateMachine.currentState.id.setValueFromSource({value: state.nodeId, dataType: DataType.NodeId})
            this.setEffectiveDisplayName([state])
        }
    }
}

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

        // provide some geographical location
        device.operationalLocation?.setValueFromSource({dataType: DataType.String, value: "N 51 E 6.2"})

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
        this.deviceStateMachine = promoteToFiniteStateMachine(device.deviceState)
        this.machineryItemState = device.machineryItemState?promoteToFiniteStateMachine(device.machineryItemState):undefined
        this.machineryOperationMode = device.machineryOperationMode?promoteToFiniteStateMachine(device.machineryOperationMode):undefined
        const functionalUnits = getLADSFunctionalUnits(device)
        functionalUnits.forEach((functionalUnit) => {
            const functionalUnitStateMachine = promoteToFiniteStateMachine(functionalUnit.functionalUnitState)
            functionalUnitStateMachine.currentState.on('value_changed', this.onFunctionalUnitStateChanged.bind(this, functionalUnit, functionalUnitStateMachine))
            this.functionalUnitStateMachines.push(functionalUnitStateMachine)
        })

        // bind state changes
        device.deviceState.currentState.on('value_changed', this.onDeviceStateChanged.bind(this))
        device.machineryItemState?.currentState.on('value_changed', this.onMachineryItemStateChanged.bind(this))
        device.machineryOperationMode?.currentState.on('value_changed', this.onMachineryOperationModeChanged.bind(this))
        device.deviceHealth?.on('value_changed', this.onDeviceHealthChanged.bind(this))

        // bind methods
        device.deviceState.gotoOperate?.bindMethod(this.onGotoOperating.bind(this))
        device.deviceState.gotoSleep?.bindMethod(this.onGotoSleep.bind(this))
        device.deviceState.gotoShutdown?.bindMethod(this.onGotoShutdown.bind(this))
        device.machineryOperationMode?.gotoMaintenance?.bindMethod(this.onGotoOperationMode.bind(this, MachineryOperationMode.Maintenance))
        device.machineryOperationMode?.gotoProcessing?.bindMethod(this.onGotoOperationMode.bind(this, MachineryOperationMode.Processing))
        device.machineryOperationMode?.gotoSetup?.bindMethod(this.onGotoOperationMode.bind(this, MachineryOperationMode.Setup))

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
        this.deviceStateMachine.setState(LADSDeviceState.Initialization)
        this.machineryOperationMode?.setState(MachineryOperationMode.None)
        sleepMilliSeconds(this.options?.initializationTime?this.options.initializationTime:50).then(() => this.enterDeviceOperating())
    }

    enterDeviceOperating() {
        const state = state2str(this.deviceStateMachine.getCurrentState())
        if (state.includes(LADSDeviceState.Operate)) return
        this.deviceStateMachine.setState(LADSDeviceState.Operate)
        this.machineryOperationMode?.setState(MachineryOperationMode.Processing)
    }

    enterDeviceSleep() {
        this.deviceStateMachine.setState(LADSDeviceState.Sleep)
    }

    enterDeviceShutdown() {
        this.deviceStateMachine.setState(LADSDeviceState.Shutdown)
        this.machineryOperationMode?.setState(MachineryOperationMode.None)
        sleepMilliSeconds(this.options?.shutdownTime?this.options.shutdownTime:1000).then(() => { this.enterDeviceInitialzation() })
    }

    async onDeviceStateChanged(dataValue: DataValueT<LocalizedText, DataType.LocalizedText>){ 
        const state = dataValue.value.value.text
        if (!state) return
        this.raiseEvent(`state changed to ${state} .. `)
        if (!state.includes(LADSDeviceState.Operate)) {
            this.adjustMachineryItemState()
        }
    }

    async onDeviceHealthChanged(dataValue: DataValueT<EnumDeviceHealth, DataType.UInt32>) { 
        const value = dataValue.value.value
        const key = Object.keys(EnumDeviceHealth)[Object.values(EnumDeviceHealth).indexOf(value)]
        this.raiseEvent(`health changed to ${key} .. `)
        if (value == EnumDeviceHealth.FAILURE) {
            this.machineryItemState?.setState(MachineryItemState.OutOfService)
            this.functionalUnitStateMachines.forEach((stateMachine) => {
                if (state2str(stateMachine.getCurrentState()).includes(LADSFunctionalState.Running)) {
                    stateMachine.setState(LADSFunctionalState.Aborting)
                    sleepMilliSeconds(1000).then(() => stateMachine.setState(LADSFunctionalState.Aborted))
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

    adjustMachineryItemState(): number {
        const functionalUnitStates = this.functionalUnitStateMachines.map((stateMachine => (state2str(stateMachine.getCurrentState()))))
        const functionalUnitsRunnning = functionalUnitStates.reduce((count, state) => { return state.includes(LADSFunctionalState.Running)?count +1:count }, 0)    
        this.machineryItemState?.setState(functionalUnitsRunnning>0?MachineryItemState.Executing:MachineryItemState.NotExecuting)
        return functionalUnitsRunnning
    }

    async onFunctionalUnitStateChanged(functionalUnit: UAObject, stateMachine: UAStateMachineEx, dataValue: DataValueT<LocalizedText, DataType.LocalizedText>) { 
        const state = dataValue.value.value.text
        if (!state) return
        this.raiseEvent(`${functionalUnit.getDisplayName()} state changed to ${state} ..`)
        sleepMilliSeconds(50).then(() => {
            this.adjustMachineryItemState()
        })        
    }
}

function state2str(value: string | null) {return value?value:''}
