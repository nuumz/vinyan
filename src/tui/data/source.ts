/**
 * DataSource — interface + embedded implementation for the TUI data layer.
 *
 * The DataSource bridges the Vinyan Orchestrator / Bus to the TUI state.
 * EmbeddedDataSource subscribes directly to bus events.
 */

import type { BusEventName, VinyanBus } from '../../core/bus.ts';
import { getHealthCheck } from '../../observability/health.ts';
import { getSystemMetrics, type MetricsDeps } from '../../observability/metrics.ts';
import type { Orchestrator } from '../../orchestrator/factory.ts';
import type { TaskInput, TaskResult } from '../../orchestrator/types.ts';
import { pushEvent } from '../state.ts';
import type { PeerDisplayState, TaskDisplayState, TUIState } from '../types.ts';
import { isDefaultVisible, mapBusEvent } from './event-mapper.ts';

// ── DataSource Interface ────────────────────────────────────────────

export interface DataSource {
  start(): void;
  stop(): void;
  submitTask(input: TaskInput): Promise<TaskResult>;
  approveTask(taskId: string): void;
  rejectTask(taskId: string): void;
  cancelTask(taskId: string): void;
  triggerSleepCycle(): void;
  exportPatterns(outputPath: string): void;
}

// ── Embedded DataSource ─────────────────────────────────────────────

export class EmbeddedDataSource implements DataSource {
  private state: TUIState;
  private orchestrator: Orchestrator;
  private bus: VinyanBus;
  private unsubscribers: Array<() => void> = [];
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  constructor(state: TUIState, orchestrator: Orchestrator) {
    this.state = state;
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
  }

  start(): void {
    this.subscribeToEvents();
    this.startMetricsPolling();
    this.startClockTick();
    this.refreshMetrics();
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  async submitTask(input: TaskInput): Promise<TaskResult> {
    return this.orchestrator.executeTask(input);
  }

  approveTask(taskId: string): void {
    // Delegate to the orchestrator's ApprovalGate to resolve the pending promise
    this.orchestrator.approvalGate?.resolve(taskId, 'approved');
    // Update task display state
    const task = this.state.tasks.get(taskId);
    if (task) {
      task.status = 'running';
      task.pendingApproval = undefined;
      this.state.dirty = true;
    }
  }

  rejectTask(taskId: string): void {
    this.orchestrator.approvalGate?.resolve(taskId, 'rejected');
    const task = this.state.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.pendingApproval = undefined;
      this.state.dirty = true;
    }
  }

  cancelTask(taskId: string): void {
    const task = this.state.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.pendingApproval = undefined;
      this.state.dirty = true;
    }
    this.bus.emit('task:timeout', { taskId, elapsedMs: 0, budgetMs: 0 });
  }

  triggerSleepCycle(): void {
    if (this.orchestrator.sleepCycleRunner) {
      this.orchestrator.sleepCycleRunner.run().catch(() => {});
    }
  }

  exportPatterns(outputPath: string): void {
    const store = this.orchestrator.patternStore;
    if (!store) return;
    import('../../evolution/pattern-abstraction.ts').then(({ exportPatterns }) => {
      const patterns = store.findActive();
      const exported = exportPatterns(patterns, 'vinyan');
      Bun.write(outputPath, JSON.stringify(exported, null, 2)).catch(() => {});
    });
  }

  // ── Event Subscriptions ─────────────────────────────────────────

  private subscribeToEvents(): void {
    // Subscribe to ALL known bus events for the event log
    const allEvents: BusEventName[] = [
      'task:start',
      'task:complete',
      'task:escalate',
      'task:timeout',
      'task:approval_required',
      'task:explore',
      'task:uncertain',
      'worker:dispatch',
      'worker:complete',
      'worker:error',
      'worker:registered',
      'worker:promoted',
      'worker:demoted',
      'worker:reactivated',
      'worker:selected',
      'worker:exploration',
      'oracle:verdict',
      'oracle:contradiction',
      'oracle:deliberation_request',
      'critic:verdict',
      'evolution:rulesApplied',
      'evolution:rulePromoted',
      'evolution:ruleRetired',
      'skill:match',
      'skill:miss',
      'skill:outcome',
      'sleep:cycleComplete',
      'shadow:enqueue',
      'shadow:complete',
      'shadow:failed',
      'guardrail:injection_detected',
      'guardrail:bypass_detected',
      'guardrail:violation',
      'peer:connected',
      'peer:disconnected',
      'peer:trustChanged',
      'a2a:verdictReceived',
      'a2a:knowledgeImported',
      'a2a:knowledgeOffered',
      'a2a:knowledgeAccepted',
      'a2a:capabilityUpdated',
      'a2a:intentDeclared',
      'a2a:intentConflict',
      'a2a:proposalReceived',
      'a2a:commitmentFailed',
      'a2a:retractionReceived',
      'a2a:feedbackReceived',
      'pipeline:re-verify',
      'pipeline:escalate',
      'pipeline:refuse',
      'fleet:convergence_warning',
      'fleet:emergency_reactivation',
      'fleet:diversity_enforced',
      'circuit:open',
      'circuit:close',
      'observability:alert',
      'memory:eviction_warning',
      'context:verdict_omitted',
      'selfmodel:predict',
      'selfmodel:calibration_error',
      'selfmodel:systematic_miscalibration',
      'commit:rejected',
      'decomposer:fallback',
      'tools:executed',
      'trace:record',
      'api:request',
      'api:response',
      'session:created',
      'session:compacted',
      'file:hashChanged',
      'graph:fact',
    ];

    for (const eventName of allEvents) {
      const unsub = this.bus.on(eventName, (payload) => {
        this.handleBusEvent(eventName, payload);
      });
      this.unsubscribers.push(unsub);
    }
  }

  private handleBusEvent(event: BusEventName, payload: unknown): void {
    // Always push to event log (filtering is done at display time)
    if (isDefaultVisible(event)) {
      const entry = mapBusEvent(event, payload);
      pushEvent(this.state, entry);
    }

    // Update domain-specific state
    const p = payload as Record<string, unknown>;
    switch (event) {
      case 'task:start':
        this.onTaskStart(p);
        break;
      case 'task:complete':
        this.onTaskComplete(p);
        break;
      case 'task:escalate':
        this.onTaskEscalate(p);
        break;
      case 'task:approval_required':
        this.onTaskApprovalRequired(p);
        break;
      case 'task:uncertain':
        this.onTaskUncertain(p);
        break;
      case 'oracle:verdict':
        this.onOracleVerdict(p);
        break;
      case 'worker:dispatch':
        this.onWorkerDispatch(p);
        break;
      case 'peer:connected':
        this.onPeerConnected(p);
        break;
      case 'peer:disconnected':
        this.onPeerDisconnected(p);
        break;
      case 'peer:trustChanged':
        this.onPeerTrustChanged(p);
        break;
      case 'a2a:knowledgeImported':
        this.onKnowledgeImported(p);
        break;
      case 'a2a:knowledgeOffered':
        this.onKnowledgeOffered(p);
        break;
      case 'a2a:capabilityUpdated':
        this.onCapabilityUpdated(p);
        break;
      case 'selfmodel:predict':
        this.onSelfModelPredict(p);
        break;
      case 'decomposer:fallback':
        this.onDecomposerFallback(p);
        break;
      case 'trace:record':
        this.onTraceRecord(p);
        break;
    }

    // Update real-time counters for any event
    this.incrementCounter(event);
  }

  // ── Task State Updates ──────────────────────────────────────────

  private onTaskStart(p: Record<string, unknown>): void {
    const input = p.input as Record<string, unknown> | undefined;
    const routing = p.routing as Record<string, unknown> | undefined;
    if (!input?.id) return;

    const task: TaskDisplayState = {
      id: String(input.id),
      goal: String(input.goal ?? ''),
      source: String(input.source ?? 'cli'),
      routingLevel: Number(routing?.level ?? 0),
      status: 'running',
      startedAt: Date.now(),
      riskScore: routing?.riskScore as number | undefined,
      workerId: routing?.workerId as string | undefined,
      pipeline: {
        perceive: 'running',
        predict: 'pending',
        plan: 'pending',
        generate: 'pending',
        verify: 'pending',
        learn: 'pending',
      },
      oracleVerdicts: [],
    };
    this.state.tasks.set(task.id, task);
    // Auto-select first task if none selected
    if (!this.state.selectedTaskId) {
      this.state.selectedTaskId = task.id;
    }
    this.state.dirty = true;
  }

  private onTaskComplete(p: Record<string, unknown>): void {
    const result = p.result as Record<string, unknown> | undefined;
    if (!result?.id) return;
    const task = this.state.tasks.get(String(result.id));
    if (!task) return;

    task.status = (result.status as TaskDisplayState['status']) ?? 'completed';
    task.completedAt = Date.now();
    task.durationMs = task.completedAt - task.startedAt;
    const qs = result.qualityScore as Record<string, unknown> | undefined;
    task.qualityScore = qs?.composite as number | undefined;
    // Mark all pipeline steps as done
    for (const step of Object.keys(task.pipeline) as Array<keyof typeof task.pipeline>) {
      task.pipeline[step] = 'done';
    }

    // Track success history for sparklines (keep last 50)
    const isSuccess = task.status === 'completed';
    this.state.successHistory.push(isSuccess ? 1 : 0);
    if (this.state.successHistory.length > 50) {
      this.state.successHistory.shift();
    }

    this.state.dirty = true;
  }

  private onTaskEscalate(p: Record<string, unknown>): void {
    const task = this.state.tasks.get(String(p.taskId ?? ''));
    if (task) {
      task.routingLevel = Number(p.toLevel ?? task.routingLevel);
      task.status = 'escalated';
      this.state.dirty = true;
    }
  }

  private onTaskApprovalRequired(p: Record<string, unknown>): void {
    const task = this.state.tasks.get(String(p.taskId ?? ''));
    if (task) {
      task.status = 'approval_required';
      task.pendingApproval = {
        riskScore: Number(p.riskScore ?? 0),
        reason: String(p.reason ?? ''),
      };
      this.state.dirty = true;

      // Auto-open approval modal if we're on the tasks tab
      if (this.state.activeTab === 'tasks') {
        this.state.modal = {
          type: 'approval',
          taskId: task.id,
          riskScore: task.pendingApproval.riskScore,
          reason: task.pendingApproval.reason,
        };
      }
    }
  }

  private onTaskUncertain(p: Record<string, unknown>): void {
    const task = this.state.tasks.get(String(p.taskId ?? ''));
    if (task) {
      task.status = 'uncertain';
      this.state.dirty = true;
    }
  }

  private onOracleVerdict(p: Record<string, unknown>): void {
    const taskId = String(p.taskId ?? '');
    const task = this.state.tasks.get(taskId);
    if (!task) return;
    const v = p.verdict as Record<string, unknown> | undefined;
    task.oracleVerdicts.push({
      name: String(p.oracleName ?? ''),
      verified: Boolean(v?.verified),
      confidence: Number(v?.confidence ?? 0),
    });
    // Update pipeline step to verify
    task.pipeline.verify = 'running';
    task.pipeline.generate = 'done';
    this.state.dirty = true;
  }

  private onWorkerDispatch(p: Record<string, unknown>): void {
    const task = this.state.tasks.get(String(p.taskId ?? ''));
    if (task) {
      task.pipeline.perceive = 'done';
      task.pipeline.predict = 'done';
      task.pipeline.plan = 'done';
      task.pipeline.generate = 'running';
      const routing = p.routing as Record<string, unknown> | undefined;
      task.workerId = routing?.workerId as string | undefined;
      this.state.dirty = true;
    }
  }

  // ── Peer State Updates ──────────────────────────────────────────

  private onPeerConnected(p: Record<string, unknown>): void {
    const peerId = String(p.peerId ?? '');
    const existing = this.state.peers.get(peerId);
    if (existing) {
      existing.healthState = 'connected';
      existing.lastSeen = Date.now();
    } else {
      const peer: PeerDisplayState = {
        peerId,
        instanceId: String(p.instanceId ?? ''),
        url: String(p.url ?? ''),
        trustLevel: 'untrusted',
        healthState: 'connected',
        interactions: 0,
        lastSeen: Date.now(),
        capabilities: [],
        knowledgeImported: 0,
        knowledgeOffered: 0,
      };
      this.state.peers.set(peerId, peer);
      if (!this.state.selectedPeerId) {
        this.state.selectedPeerId = peerId;
      }
    }
    this.state.dirty = true;
  }

  private onPeerDisconnected(p: Record<string, unknown>): void {
    const peer = this.state.peers.get(String(p.peerId ?? ''));
    if (peer) {
      peer.healthState = 'partitioned';
      this.state.dirty = true;
    }
  }

  private onPeerTrustChanged(p: Record<string, unknown>): void {
    const peer = this.state.peers.get(String(p.peerId ?? ''));
    if (peer) {
      peer.trustLevel = p.to as PeerDisplayState['trustLevel'];
      peer.interactions++;
      this.state.dirty = true;
    }
  }

  private onKnowledgeImported(p: Record<string, unknown>): void {
    const peer = this.state.peers.get(String(p.peerId ?? ''));
    if (peer) {
      peer.knowledgeImported += Number(p.patternsImported ?? 0);
      this.state.dirty = true;
    }
  }

  private onKnowledgeOffered(p: Record<string, unknown>): void {
    const peer = this.state.peers.get(String(p.peerId ?? ''));
    if (peer) {
      peer.knowledgeOffered += Number(p.patternCount ?? 0);
      this.state.dirty = true;
    }
  }

  private onCapabilityUpdated(p: Record<string, unknown>): void {
    const peer = this.state.peers.get(String(p.peerId ?? ''));
    if (peer) {
      peer.instanceId = String(p.instanceId ?? peer.instanceId);
      peer.lastSeen = Date.now();
      this.state.dirty = true;
    }
  }

  // ── Pipeline Step Updates ──────────────────────────────────────

  private onSelfModelPredict(p: Record<string, unknown>): void {
    // selfmodel:predict fires after Step 2 (PREDICT) — find the active task
    const prediction = p.prediction as Record<string, unknown> | undefined;
    const taskId = prediction?.taskId as string | undefined;
    // If prediction has a taskId, use it; otherwise update the most recently started task
    const task = taskId
      ? this.state.tasks.get(taskId)
      : [...this.state.tasks.values()].find((t) => t.status === 'running' && t.pipeline.predict === 'pending');
    if (task) {
      task.pipeline.perceive = 'done';
      task.pipeline.predict = 'done';
      task.pipeline.plan = 'running';
      this.state.dirty = true;
    }
  }

  private onDecomposerFallback(p: Record<string, unknown>): void {
    const task = this.state.tasks.get(String(p.taskId ?? ''));
    if (task) {
      task.pipeline.plan = 'done';
      this.state.dirty = true;
    }
  }

  private onTraceRecord(p: Record<string, unknown>): void {
    // trace:record fires during Step 6 (LEARN) — mark learn step
    const trace = p.trace as Record<string, unknown> | undefined;
    const taskId = String(trace?.taskId ?? '');
    const task = this.state.tasks.get(taskId);
    if (task && task.pipeline.learn !== 'done') {
      task.pipeline.verify = 'done';
      task.pipeline.learn = 'running';
      this.state.dirty = true;
    }
  }

  // ── Real-time Counters ──────────────────────────────────────────

  private incrementCounter(event: string): void {
    // Extract domain from event name (e.g. 'task:start' → 'task')
    const domain = event.split(':')[0] ?? 'other';
    this.state.realtimeCounters[domain] = (this.state.realtimeCounters[domain] ?? 0) + 1;
  }

  // ── Metrics Polling ─────────────────────────────────────────────

  private startMetricsPolling(): void {
    this.metricsTimer = setInterval(() => this.refreshMetrics(), 5000);
  }

  /** Tick every 1s to keep clock and uptime fresh. */
  private startClockTick(): void {
    this.clockTimer = setInterval(() => {
      this.state.dirty = true;
    }, 1000);
  }

  private refreshMetrics(): void {
    try {
      const deps: MetricsDeps = {
        traceStore: this.orchestrator.traceStore!,
        ruleStore: this.orchestrator.ruleStore,
        skillStore: this.orchestrator.skillStore,
        patternStore: this.orchestrator.patternStore,
        shadowStore: this.orchestrator.shadowStore,
        workerStore: this.orchestrator.workerStore,
      };
      if (deps.traceStore) {
        this.state.metrics = getSystemMetrics(deps);
      }
    } catch {
      // Best-effort
    }

    try {
      this.state.health = getHealthCheck({
        shadowQueueDepth: this.state.metrics?.shadow.queueDepth ?? 0,
      });
    } catch {
      // Best-effort
    }

    this.state.dirty = true;
  }
}
