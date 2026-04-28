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
