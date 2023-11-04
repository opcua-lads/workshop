/**
 *
 * Copyright (c) 2023 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 * Copyright (c) 2023 SPECTARIS - Deutscher Industrieverband für optische, medizinische und mechatronische Technologien e.V. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
    DataType,
    DateTime,
    LocalizedText,
    UAAnalogUnitRange,
    UAExclusiveDeviationAlarm,
    UAExclusiveLimitAlarm,
    UAFiniteStateMachine,
    UAMethod,
    UAMultiStateDiscrete,
    UAObject,
    UAProperty,
    UAString,
    UATwoStateDiscrete,
    UAVariableT} from "node-opcua"
import { UADevice, UALockingServices } from "node-opcua-nodeset-di"

//---------------------------------------------------------------
// Interfaces for LADS devices
//---------------------------------------------------------------
export interface LADSDevice extends UADevice {
    functionalUnitSet: LADSFunctionalUnitSet
    stateMachine: LADSDeviceStateMachine
    machineryItemState?: UAFiniteStateMachine
    machineryOperationMode?: MachineryOperationModeStateMachine
    operationalLocation?: UAProperty<UAString, DataType.String>
    hierarchicalLocation?: UAProperty<UAString, DataType.String>
    identifictaion?: LADSIdentifictaion
    lock?: UALockingServices
}

export interface LADSIdentifictaion extends UAObject {
    
}

export interface LADSFunctionalUnitSet  {
    [key: string]: LADSFunctionalUnit
}

//---------------------------------------------------------------
// Interfaces for LADS functional unit
//---------------------------------------------------------------
export interface LADSFunctionalUnit extends UAObject {
    functionSet: LADSFunctionSet
    programManager: {
        programTemplateSet: LADSProgramTemplateSet
        activeProgram: LADSActiveProgram
        resultSet: LADSResultSet
    }
    stateMachine: LADSFunctionalUnitStateMachine
    lock?: UALockingServices
}

export interface LADSFunctionSet {
    [key: string]: LADSFunction
}

//---------------------------------------------------------------
// Interfaces for LADS state machines
//---------------------------------------------------------------
export interface LADSDeviceStateMachine extends UAFiniteStateMachine {
    gotoOperate?: UAMethod
    gotoShutdown?: UAMethod
    gotoSleep?: UAMethod
}

export interface MachineryOperationModeStateMachine extends UAFiniteStateMachine {
    gotoMaintenance?: UAMethod
    gotoProcessing?: UAMethod
    gotoSetup?: UAMethod
}

export interface LADSCoverStateMachine extends UAFiniteStateMachine {
    open: UAMethod
    close: UAMethod
    lock?: UAMethod
    unlock?: UAMethod
}

export interface LADSFunctionalStateMachine extends UAFiniteStateMachine {
    runningStateMachine: LADSRunnnigStateMachine
    start: UAMethod
    stop: UAMethod
    abort: UAMethod
    clear?: UAMethod
}

export interface LADSFunctionalUnitStateMachine extends LADSFunctionalStateMachine {
    startProgram?: UAMethod
}

export interface LADSControlFunctionStateMachine extends LADSFunctionalStateMachine {
    startWithTargetValue?: UAMethod
}

export interface LADSRunnnigStateMachine extends UAFiniteStateMachine {
    suspend: UAMethod
    unsuspend: UAMethod
    hold: UAMethod
    unhold: UAMethod
    toComplete: UAMethod
    reset: UAMethod
    start: UAMethod
}

//---------------------------------------------------------------
// Interfaces for LADS functions
//---------------------------------------------------------------
export interface LADSFunction extends UAObject {
    isEnabled: UAProperty<boolean, DataType.Boolean>
    functionSet?: LADSFunctionSet
}

export interface LADSCoverFunction extends LADSFunction {
    stateMachine: LADSCoverStateMachine
}

//---------------------------------------------------------------
// Interfaces for LADS sensor-functions
//---------------------------------------------------------------
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

//---------------------------------------------------------------
// Interfaces for LADS control-functions
//---------------------------------------------------------------
interface LADSBaseControlFunction extends LADSFunction {
    alarmMonitor?: UAExclusiveDeviationAlarm
    stateMachine: LADSControlFunctionStateMachine
}

export interface LADSAnalogControlFunction extends LADSBaseControlFunction {
    currentValue: UAAnalogUnitRange<number, DataType.Double>
    targetValue: UAAnalogUnitRange<number, DataType.Double>
}

export interface LADSMultiStateDiscreteControlFunction extends LADSBaseControlFunction {
    currentValue: UAMultiStateDiscrete<number, DataType.UInt32>
    targetValue: UAMultiStateDiscrete<number, DataType.UInt32>
}

export interface LADSTwoStateDiscreteControlFunction extends LADSBaseControlFunction {
    currentValue: UATwoStateDiscrete<boolean>
    targetValue: UATwoStateDiscrete<boolean>
}

//---------------------------------------------------------------
// Interfaces for LADS program-manager
//---------------------------------------------------------------
export interface LADSActiveProgram {
    currentProgramTemplate?: UAProperty<any, DataType.ExtensionObject>
    currentRuntime?: UAProperty<number, DataType.Double>
    currentPauseTime?: UAProperty<number, DataType.Double>
    currentStepName?: UAProperty<LocalizedText, DataType.LocalizedText>
    currentStepRuntime?: UAProperty<number, DataType.Double>
    currentStepNumber?: UAProperty<number, DataType.UInt32>
    estimatedRuntime?: UAProperty<number, DataType.Double>
    estimatedStepRuntime?: UAProperty<number, DataType.Double>
    estimatedStepNumbers?: UAProperty<number, DataType.UInt32>
    deviceProgramRunId?: UAProperty<string, DataType.String>
}

export interface LADSProgramTemplateSet {
    [key: string]: LADSProgramTemplate
}

export interface LADSProgramTemplate extends UAObject {
    author: UAProperty<string, DataType.String>
    deviceTemplateId: UAProperty<string, DataType.String>
    supervisoryTemplateId?: UAProperty<string, DataType.String>
    created: UAProperty<DateTime, DataType.DateTime>
    modified: UAProperty<DateTime, DataType.DateTime>
}

export interface LADSResultSet {
    [key: string]: LADSResult
}

export interface LADSResult extends UAObject {
    name: UAProperty<string, DataType.String>
    supervisoryJobId?: UAProperty<string, DataType.String>
    supervisoryTaskId?: UAProperty<string, DataType.String>
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
