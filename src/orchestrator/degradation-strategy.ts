import type { VinyanBus, VinyanBusEvents } from '../core/bus.ts';

export const DEGRADATION_POLICY_VERSION = 'degradation-strategy:v1' as const;

export type DegradationEvent = VinyanBusEvents['degradation:triggered'];
export type DegradationFailureType = DegradationEvent['failureType'];
export type DegradationAction = DegradationEvent['action'];

interface DegradationStrategyEntry {
  action: DegradationAction;
  capabilityImpact: DegradationEvent['capabilityImpact'];
  retryable: boolean;
  severity: DegradationEvent['severity'];
}

const DEFAULT_STRATEGY: Record<DegradationFailureType, DegradationStrategyEntry> = {
  'oracle-unavailable': { action: 'fallback', capabilityImpact: 'reduced', retryable: true, severity: 'warning' },
  'llm-provider-failure': { action: 'retry', capabilityImpact: 'reduced', retryable: true, severity: 'warning' },
  'tool-timeout': { action: 'retry', capabilityImpact: 'reduced', retryable: true, severity: 'warning' },
  'tool-failure': { action: 'retry', capabilityImpact: 'reduced', retryable: true, severity: 'warning' },
  'rate-limit': { action: 'degrade', capabilityImpact: 'reduced', retryable: true, severity: 'warning' },
  'peer-unavailable': { action: 'degrade', capabilityImpact: 'reduced', retryable: true, severity: 'warning' },
  'trace-store-write-failure': {
    action: 'fail-closed',
    capabilityImpact: 'blocked',
    retryable: false,
    severity: 'critical',
  },
  'budget-pressure': { action: 'degrade', capabilityImpact: 'reduced', retryable: true, severity: 'warning' },
};

interface DegradationInput {
  failureType: DegradationFailureType;
  component: string;
  reason: string;
  sourceEvent: string;
  taskId?: string;
  occurredAt?: number;
}

export function decideDegradation(input: DegradationInput): DegradationEvent {
  const strategy = DEFAULT_STRATEGY[input.failureType];
  return {
    taskId: input.taskId,
    failureType: input.failureType,
    component: input.component,
    action: strategy.action,
    capabilityImpact: strategy.capabilityImpact,
    retryable: strategy.retryable,
    severity: strategy.severity,
    policyVersion: DEGRADATION_POLICY_VERSION,
    reason: input.reason,
    sourceEvent: input.sourceEvent,
    occurredAt: input.occurredAt ?? Date.now(),
  };
}

export function emitDegradation(bus: VinyanBus, input: DegradationInput): DegradationEvent {
  const event = decideDegradation(input);
  bus.emit('degradation:triggered', event);
  return event;
}

export function attachDegradationEventBridge(bus: VinyanBus): { detach: () => void } {
  const unsubs = [
    bus.on('circuit:open', ({ oracleName, failureCount }) => {
      emitDegradation(bus, {
        failureType: 'oracle-unavailable',
        component: `oracle:${oracleName}`,
        reason: `Circuit breaker opened after ${failureCount} failures`,
        sourceEvent: 'circuit:open',
      });
    }),
    bus.on('worker:error', ({ taskId, error, routing }) => {
      emitDegradation(bus, {
        taskId,
        failureType: classifyWorkerFailure(error),
        component: routing.workerId ?? routing.model ?? 'worker',
        reason: error,
        sourceEvent: 'worker:error',
      });
    }),
    bus.on('task:timeout', ({ taskId, lastTool, reason }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'tool-timeout',
        component: lastTool ? `tool:${lastTool.name}` : 'task-runtime',
        reason: reason ?? 'Task timed out before completion',
        sourceEvent: 'task:timeout',
      });
    }),
    bus.on('tool:failure_classified', ({ taskId, type, recoverable, error }) => {
      emitDegradation(bus, {
        taskId,
        failureType: classifyToolFailure(type),
        component: 'tool-runtime',
        reason: `${recoverable ? 'Recoverable' : 'Unrecoverable'} tool failure: ${error}`,
        sourceEvent: 'tool:failure_classified',
      });
    }),
    bus.on('task:budget-exceeded', ({ taskId, totalTokensConsumed, globalCap }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'budget-pressure',
        component: 'budget-enforcer',
        reason: `Global token budget exceeded: ${totalTokensConsumed} > ${globalCap}`,
        sourceEvent: 'task:budget-exceeded',
      });
    }),
    bus.on('decomposer:fallback', ({ taskId }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'llm-provider-failure',
        component: 'task-decomposer',
        reason: 'Task decomposer fell back to a simpler planning path',
        sourceEvent: 'decomposer:fallback',
      });
    }),
    bus.on('spec:drafting_failed', ({ taskId, reason }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'llm-provider-failure',
        component: 'spec-refinement',
        reason,
        sourceEvent: 'spec:drafting_failed',
      });
    }),
    bus.on('brainstorm:drafting_failed', ({ taskId, reason }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'llm-provider-failure',
        component: 'brainstorm',
        reason,
        sourceEvent: 'brainstorm:drafting_failed',
      });
    }),
    bus.on('peer:disconnected', ({ peerId, reason }) => {
      emitDegradation(bus, {
        failureType: 'peer-unavailable',
        component: `peer:${peerId}`,
        reason,
        sourceEvent: 'peer:disconnected',
      });
    }),
    bus.on('trace:write_failed', ({ taskId, traceId, error }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'trace-store-write-failure',
        component: 'trace-store',
        reason: `Trace ${traceId} failed to persist: ${error}`,
        sourceEvent: 'trace:write_failed',
      });
    }),
    // A9 broader failure-class coverage (2026-04-28): bridge the remaining
    // failure events that previously emitted but were never normalized into
    // the A9 degradation contract.
    bus.on('shadow:failed', ({ job, error }) => {
      emitDegradation(bus, {
        taskId: job.taskId,
        // Shadow is a post-commit verification subsystem; treat its failure
        // as a verification-side oracle outage so dashboards group it with
        // other oracle-unavailable signals.
        failureType: 'oracle-unavailable',
        component: 'shadow-runner',
        reason: `Shadow job ${job.id} failed: ${error}`,
        sourceEvent: 'shadow:failed',
      });
    }),
    bus.on('tool:remediation_failed', ({ taskId, reason }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'tool-failure',
        component: 'tool-remediation',
        reason: `Tool auto-remediation exhausted: ${reason}`,
        sourceEvent: 'tool:remediation_failed',
      });
    }),
    bus.on('testgen:error', ({ taskId, error }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'llm-provider-failure',
        component: 'test-generator',
        reason: `Test generation failed: ${error}`,
        sourceEvent: 'testgen:error',
      });
    }),
    bus.on('selfmodel:calibration_error', ({ taskId, error }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'llm-provider-failure',
        component: 'self-model-calibration',
        reason: `Self-model calibration failed: ${error}`,
        sourceEvent: 'selfmodel:calibration_error',
      });
    }),
    bus.on('agent:synthesis-failed', ({ taskId, suggestedId, reason }) => {
      emitDegradation(bus, {
        taskId,
        failureType: 'llm-provider-failure',
        component: `agent-synthesis:${suggestedId}`,
        reason: `Agent synthesis failed: ${reason}`,
        sourceEvent: 'agent:synthesis-failed',
      });
    }),
  ];

  return {
    detach: () => {
      for (const unsub of unsubs) unsub();
    },
  };
}

export function classifyWorkerFailure(error: string): DegradationFailureType {
  const normalized = error.toLowerCase();
  if (
    normalized.includes('429') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('quota')
  ) {
    return 'rate-limit';
  }
  return 'llm-provider-failure';
}

export function classifyToolFailure(type: string): DegradationFailureType {
  return type.toLowerCase().includes('timeout') ? 'tool-timeout' : 'tool-failure';
}
