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
    AddressSpace,
    DataType,
    DateTime,
    INamespace,
    LocalizedText,
    UAAnalogUnitRange,
    UAExclusiveDeviationAlarm,
    UAExclusiveLimitAlarm,
    UAMethod,
    UAObject,
    UAObjectType,
    UAProperty,
    UAStateMachine
} from "node-opcua"
import { UADevice } from "node-opcua-nodeset-di"

export interface LADSFunctionSet {
    [key: string]: LADSFunction
}

export interface LADSFunctionalUnit extends UAObject {
    functionSet: LADSFunctionSet
    programManager: {
        programTemplateSet: LADSProgramTemplateSet
        activeProgram: LADSActiveProgram
        resultSet: LADSResultSet
    }
    stateMachine: LADSFunctionalStateMachine
}

export interface LADSActiveProgram {
    currentRuntime?: UAProperty<number, DataType.Double>
    currentPauseTime?: UAProperty<number, DataType.Double>
    currentStepName?: UAProperty<LocalizedText, DataType.LocalizedText>
    currentStepRuntime?: UAProperty<number, DataType.Double>
    currentStepNumber?: UAProperty<number, DataType.UInt32>
    estimatedRuntime?: UAProperty<number, DataType.Double>
    estimatedStepRuntime?: UAProperty<number, DataType.Double>
    estimatedStepNumbers?: UAProperty<number, DataType.UInt32>
    deviceProgramRunId?: UAProperty<string, DataType.String>
    programTemplate?: LADSProgramTemplate
}

export interface LADSProgramTemplateSet {
    [key: string]: LADSProgramTemplate
}

export interface LADSProgramTemplate extends UAObject {
    name: UAProperty<string, DataType.String>
    author: UAProperty<string, DataType.String>
    created: UAProperty<DateTime, DataType.DateTime>
    modified: UAProperty<DateTime, DataType.DateTime>
}

export interface LADSResultSet {
    [key: string]: LADSResult
}

export interface LADSResult extends UAObject {
    name: UAProperty<string, DataType.String>
    jobId: UAProperty<string, DataType.String>
    supervisoryTaskId: UAProperty<string, DataType.String>
    properties: UAProperty<any, DataType.ExtensionObject>
    samples: UAProperty<any, DataType.ExtensionObject>
    deviceProgramRunId?: UAProperty<string, DataType.String>
    started: UAProperty<DateTime, DataType.DateTime>
    stopped: UAProperty<DateTime, DataType.DateTime>
    totalRuntime?: UAProperty<number, DataType.Double>
    totalPauseTime?: UAProperty<number, DataType.Double>
    variableSet: UAObject
    fileSet: UAObject
    programTemplate: LADSProgramTemplate
}

export interface LADSFunctionalUnitSet  {
    [key: string]: LADSFunctionalUnit
}

export interface LADSDevice extends UADevice {
    functionalUnitSet: LADSFunctionalUnitSet
}

export interface LADSCoverStateMachine extends UAStateMachine {
    open: UAMethod
    close: UAMethod
    lock: UAMethod
    unlock: UAMethod
}

export interface LADSFunctionalStateMachine extends UAStateMachine {
    runningStateMachine: LADSRunnnigStateMachine
    start: UAMethod
    startProgram: UAMethod
    stop: UAMethod
    abort: UAMethod
    clear: UAMethod
}

export interface LADSRunnnigStateMachine extends UAStateMachine {
    suspend: UAMethod
    unsuspend: UAMethod
    hold: UAMethod
    unhold: UAMethod
    toComplete: UAMethod
    reset: UAMethod
    start: UAMethod
}

interface LADSFunction extends UAObject {
    isEnabled: UAProperty<boolean, DataType.Boolean>
}

export interface LADSCoverFunction extends LADSFunction {
    stateMachine: LADSCoverStateMachine
}

interface LADSBaseSensorFunction extends LADSFunction {
    alarmMonitor?: UAExclusiveLimitAlarm
    damping?: UAProperty<number, DataType.Double>
}

export interface LADSAnalogSensorFunction extends LADSBaseSensorFunction {
    rawValue?: UAAnalogUnitRange<number, DataType.Double>
    sensorValue: UAAnalogUnitRange<number, DataType.Double>

}

export interface LADSAnalogArraySensorFunction extends LADSBaseSensorFunction {
    rawValue?: UAAnalogUnitRange<Float64Array, DataType.Double>
    sensorValue: UAAnalogUnitRange<Float64Array, DataType.Double>

}

export interface LADSAnalogControlFunction extends LADSFunction {
    alarmMonitor?: UAExclusiveDeviationAlarm
    currentValue: UAAnalogUnitRange<number, DataType.Double>
    targetValue: UAAnalogUnitRange<number, DataType.Double>
    stateMachine: LADSFunctionalStateMachine
}

export async function sleepMilliSeconds(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

export function getLADSNamespace(addressSpace: AddressSpace): INamespace {
    return addressSpace.getNamespace('http://opcfoundation.org/UA/LADS/')
}

export function getLADSObjectType(addressSpace: AddressSpace, objectType: string): UAObjectType {
    const namespace = getLADSNamespace(addressSpace)
    assert(namespace)

    const objectTypeNode = namespace.findObjectType(objectType)
    assert(objectTypeNode)

    return objectTypeNode
}
