import { beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { GapHDetector } from '../../src/observability/gap-h-detector.ts';
import type { ExecutionTrace, TaskResult } from '../../src/orchestrator/types.ts';

function makeFailedResult(taskId: string): TaskResult {
  return {
    id: taskId,
    status: 'failed',
    mutations: [],
    trace: {
      id: `trace-${taskId}`,
      taskId,
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'test',
      oracleVerdicts: {},
      modelUsed: 'test',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'failure',
      affectedFiles: [],
    } as ExecutionTrace,
  };
}

function makeCompletedResult(taskId: string): TaskResult {
  return {
    id: taskId,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${taskId}`,
      taskId,
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'test',
      oracleVerdicts: {},
      modelUsed: 'test',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'success',
      affectedFiles: [],
    } as ExecutionTrace,
  };
}

describe('GapHDetector', () => {
  let bus: VinyanBus;
  let detector: GapHDetector;
  let alerts: Array<{ detector: string; severity: string; message: string }>;

  beforeEach(() => {
    bus = createBus({ maxListeners: 20 });
    detector = new GapHDetector(bus);
    alerts = [];
    bus.on('observability:alert', (payload) => {
      alerts.push(payload);
    });
  });

  // ── FC4: Forgot context ──────────────────────────────────────────

  describe('FC4 — Forgot context', () => {
    test('fires warning when task fails after >=2 eviction warnings', () => {
      detector.attach();

      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 1, memoryPressure: 0.8 });
      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 2, memoryPressure: 0.9 });
      bus.emit('task:complete', { result: makeFailedResult('t1') });

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.detector).toBe('FC4');
      expect(alerts[0]!.severity).toBe('warning');
      expect(alerts[0]!.message).toContain('t1');
      expect(alerts[0]!.message).toContain('2 memory eviction warnings');
    });

    test('does NOT fire when eviction count < 2', () => {
      detector.attach();

      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 1, memoryPressure: 0.5 });
      bus.emit('task:complete', { result: makeFailedResult('t1') });

      expect(alerts).toHaveLength(0);
    });

    test('does NOT fire when task succeeds despite evictions', () => {
      detector.attach();

      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 1, memoryPressure: 0.8 });
      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 2, memoryPressure: 0.9 });
      bus.emit('task:complete', { result: makeCompletedResult('t1') });

      expect(alerts).toHaveLength(0);
    });

    test('tracks evictions per task independently', () => {
      detector.attach();

      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 1, memoryPressure: 0.7 });
      bus.emit('memory:eviction_warning', { taskId: 't2', evictionCount: 1, memoryPressure: 0.8 });
      bus.emit('memory:eviction_warning', { taskId: 't2', evictionCount: 2, memoryPressure: 0.9 });

      // t1 has only 1 eviction — should not alert
      bus.emit('task:complete', { result: makeFailedResult('t1') });
      expect(alerts).toHaveLength(0);

      // t2 has 2 evictions — should alert
      bus.emit('task:complete', { result: makeFailedResult('t2') });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.detector).toBe('FC4');
    });

    test('cleans up eviction state after task completion', () => {
      detector.attach();

      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 1, memoryPressure: 0.8 });
      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 2, memoryPressure: 0.9 });
      bus.emit('task:complete', { result: makeFailedResult('t1') });

      const state = detector.getState();
      expect(state.fc4.evictions.t1).toBeUndefined();
    });
  });

  // ── FC9: Withheld info ─────────────────────────────────────────

  describe('FC9 — Withheld info', () => {
    test('fires critical alert when >=3 verdicts omitted in one task', () => {
      detector.attach();

      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'ast', reason: 'timeout' });
      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'type', reason: 'timeout' });
      expect(alerts).toHaveLength(0);

      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'lint', reason: 'circuit-open' });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.detector).toBe('FC9');
      expect(alerts[0]!.severity).toBe('critical');
      expect(alerts[0]!.message).toContain('3 omitted oracle verdicts');
    });

    test('does NOT fire when omissions < 3', () => {
      detector.attach();

      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'ast', reason: 'timeout' });
      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'type', reason: 'timeout' });

      expect(alerts).toHaveLength(0);
    });

    test('tracks omissions per task independently', () => {
      detector.attach();

      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'ast', reason: 'timeout' });
      bus.emit('context:verdict_omitted', { taskId: 't2', oracleName: 'ast', reason: 'timeout' });
      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'type', reason: 'timeout' });
      bus.emit('context:verdict_omitted', { taskId: 't2', oracleName: 'type', reason: 'timeout' });
      bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: 'lint', reason: 'timeout' });

      // Only t1 hit 3 — should fire once
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.detector).toBe('FC9');
    });

    test('fires again if additional verdicts are omitted beyond threshold', () => {
      detector.attach();

      for (let i = 0; i < 4; i++) {
        bus.emit('context:verdict_omitted', { taskId: 't1', oracleName: `oracle-${i}`, reason: 'timeout' });
      }

      // Fires at 3 and 4
      expect(alerts).toHaveLength(2);
    });
  });

  // ── FC11: Think/do mismatch ────────────────────────────────────

  describe('FC11 — Think/do mismatch', () => {
    test('fires warning when >=70% of last 20 have same bias direction', () => {
      detector.attach();

      // Emit 14 "over" and 6 "under" (14/20 = 70%)
      for (let i = 0; i < 14; i++) {
        bus.emit('selfmodel:systematic_miscalibration', {
          taskId: `t-over-${i}`,
          biasDirection: 'over',
          magnitude: 0.3,
          windowSize: 20,
        });
      }
      for (let i = 0; i < 6; i++) {
        bus.emit('selfmodel:systematic_miscalibration', {
          taskId: `t-under-${i}`,
          biasDirection: 'under',
          magnitude: 0.2,
          windowSize: 20,
        });
      }

      // Should fire on the 20th event
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.detector).toBe('FC11');
      expect(alerts[0]!.severity).toBe('warning');
      expect(alerts[0]!.message).toContain('over-prediction bias');
      expect(alerts[0]!.message).toContain('70%');
    });

    test('does NOT fire when window not full', () => {
      detector.attach();

      // Only 10 events — below window of 20
      for (let i = 0; i < 10; i++) {
        bus.emit('selfmodel:systematic_miscalibration', {
          taskId: `t-${i}`,
          biasDirection: 'over',
          magnitude: 0.3,
          windowSize: 20,
        });
      }

      expect(alerts).toHaveLength(0);
    });

    test('does NOT fire when bias is balanced', () => {
      detector.attach();

      // 10 over + 10 under = 50% each, below 70%
      for (let i = 0; i < 10; i++) {
        bus.emit('selfmodel:systematic_miscalibration', {
          taskId: `t-over-${i}`,
          biasDirection: 'over',
          magnitude: 0.3,
          windowSize: 20,
        });
      }
      for (let i = 0; i < 10; i++) {
        bus.emit('selfmodel:systematic_miscalibration', {
          taskId: `t-under-${i}`,
          biasDirection: 'under',
          magnitude: 0.2,
          windowSize: 20,
        });
      }

      expect(alerts).toHaveLength(0);
    });

    test('ring buffer evicts old entries', () => {
      detector.attach();

      // First 20: all "over" — should trigger alert
      for (let i = 0; i < 20; i++) {
        bus.emit('selfmodel:systematic_miscalibration', {
          taskId: `t-over-${i}`,
          biasDirection: 'over',
          magnitude: 0.3,
          windowSize: 20,
        });
      }
      expect(alerts).toHaveLength(1);

      // Now push 14 "under" — the ring buffer will evict old "over" entries
      // After 14 more events: 6 old "over" + 14 new "under" = 14/20 = 70% under
      alerts.length = 0;
      for (let i = 0; i < 14; i++) {
        bus.emit('selfmodel:systematic_miscalibration', {
          taskId: `t-under-${i}`,
          biasDirection: 'under',
          magnitude: 0.2,
          windowSize: 20,
        });
      }

      // Should fire for under-prediction bias
      const underAlerts = alerts.filter((a) => a.message.includes('under-prediction'));
      expect(underAlerts.length).toBeGreaterThanOrEqual(1);
    });

    test('getState reflects current ring buffer', () => {
      detector.attach();

      bus.emit('selfmodel:systematic_miscalibration', {
        taskId: 't1',
        biasDirection: 'over',
        magnitude: 0.3,
        windowSize: 20,
      });
      bus.emit('selfmodel:systematic_miscalibration', {
        taskId: 't2',
        biasDirection: 'under',
        magnitude: 0.2,
        windowSize: 20,
      });

      const state = detector.getState();
      expect(state.fc11.recentBiases).toEqual(['over', 'under']);
      expect(state.fc11.windowSize).toBe(20);
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────

  describe('cleanup', () => {
    test('detach stops all listeners', () => {
      const detach = detector.attach();

      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 1, memoryPressure: 0.8 });
      detach();
      bus.emit('memory:eviction_warning', { taskId: 't1', evictionCount: 2, memoryPressure: 0.9 });
      bus.emit('task:complete', { result: makeFailedResult('t1') });

      // The second eviction and task:complete should not have been tracked
      // FC4 only saw 1 eviction before detach, so no alert
      expect(alerts).toHaveLength(0);
    });

    test('getState returns clean state after construction', () => {
      const state = detector.getState();
      expect(state.fc4.evictions).toEqual({});
      expect(state.fc9.omissions).toEqual({});
      expect(state.fc11.recentBiases).toEqual([]);
    });
  });
});
