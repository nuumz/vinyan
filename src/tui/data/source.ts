/**
 * DataSource — interface + embedded implementation for the TUI data layer.
 *
 * The DataSource bridges the Vinyan Orchestrator / Bus to the TUI state.
 * EmbeddedDataSource subscribes directly to bus events.
 */

import type { BusEventName, VinyanBus } from '../../core/bus.ts';
import { getHealthCheck } from '../../observability/health.ts';
import { getSystemMetrics, type MetricsDeps } from '../../observability/metrics.ts';
import { generateEvolutionReport } from '../../observability/phase3-report.ts';
import type { Orchestrator } from '../../orchestrator/factory.ts';
import type { TaskInput, TaskResult } from '../../orchestrator/types.ts';
import { pushEvent } from '../state.ts';
import type { PeerDisplayState, TaskDisplayState, TUIState } from '../types.ts';
import { isDefaultVisible, mapBusEvent } from './event-mapper.ts';

// ── Log-Only Events (no state handler — event log + counter only) ──

const LOG_ONLY_EVENTS: BusEventName[] = [
  'task:timeout',
  'task:explore',
  'worker:complete',
  'worker:error',
  'profile:registered',
  'profile:promoted',
  'profile:demoted',
  'profile:reactivated',
  'profile:retired',
  'worker:selected',
  'worker:exploration',
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
  'a2a:verdictReceived',
  'a2a:knowledgeAccepted',
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
  'selfmodel:calibration_error',
  'selfmodel:systematic_miscalibration',
  'commit:rejected',
  'tools:executed',
  'api:request',
  'api:response',
  'session:created',
  'session:compacted',
  'file:hashChanged',
  'graph:fact',
  'economy:cost_recorded',
  'economy:budget_warning',
  'economy:budget_exceeded',
  'economy:cost_pattern_detected',
  'market:auction_completed',
  'market:phase_transition',
  'market:auto_activated',
  'market:settlement_accurate',
  'market:settlement_inaccurate',
  'human:review_requested',
];

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
  private metricsRunning = false;
  constructor(state: TUIState, orchestrator: Orchestrator) {
    this.state = state;
    this.orchestrator = orchestrator;
    this.bus = orchestrator.bus;
  }

  start(): void {
    this.subscribeToEvents();
    this.startMetricsPolling();
    this.startClockTick();
    // Defer initial metrics load so screen can render first frame immediately
    setTimeout(() => this.refreshMetricsAsync(), 50);
    // Chat tab (PR #11): pre-populate session list so the Chat tab is
    // not empty before any task fires. Best-effort — no-ops when
    // sessionManager is not configured.
    setTimeout(() => this.refreshChatState(), 50);
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
      this.state.stateGeneration++;
    }
  }

  rejectTask(taskId: string): void {
    this.orchestrator.approvalGate?.resolve(taskId, 'rejected');
    const task = this.state.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.pendingApproval = undefined;
      this.state.dirty = true;
      this.state.stateGeneration++;
    }
  }

  cancelTask(taskId: string): void {
    const task = this.state.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.pendingApproval = undefined;
      this.state.dirty = true;
      this.state.stateGeneration++;
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
    // Handler registry: event → state mutation function
    const handlers = new Map<BusEventName, (p: Record<string, unknown>) => void>([
      // Task state
      ['task:start', (p) => this.onTaskStart(p)],
      ['task:complete', (p) => this.onTaskComplete(p)],
      ['task:escalate', (p) => this.onTaskEscalate(p)],
      ['task:approval_required', (p) => this.onTaskApprovalRequired(p)],
      ['task:uncertain', (p) => this.onTaskUncertain(p)],
      // Oracle
      ['oracle:verdict', (p) => this.onOracleVerdict(p)],
      // Worker
      ['worker:dispatch', (p) => this.onWorkerDispatch(p)],
      // Peers
      ['peer:connected', (p) => this.onPeerConnected(p)],
      ['peer:disconnected', (p) => this.onPeerDisconnected(p)],
      ['peer:trustChanged', (p) => this.onPeerTrustChanged(p)],
      // A2A
      ['a2a:knowledgeImported', (p) => this.onKnowledgeImported(p)],
      ['a2a:knowledgeOffered', (p) => this.onKnowledgeOffered(p)],
      ['a2a:capabilityUpdated', (p) => this.onCapabilityUpdated(p)],
      // Pipeline steps
      ['selfmodel:predict', (p) => this.onSelfModelPredict(p)],
      ['decomposer:fallback', (p) => this.onDecomposerFallback(p)],
      ['trace:record', (p) => this.onTraceRecord(p)],
      // Agent sessions
      ['agent:session_start', (p) => this.onAgentSessionStart(p)],
      ['agent:session_end', (p) => this.onAgentSessionEnd(p)],
      ['agent:turn_complete', (p) => this.onAgentTurnComplete(p)],
      ['agent:tool_executed', (p) => this.onAgentToolExecuted(p)],
      // Phase D: structured clarifications (renders as selectable options).
      ['agent:clarification_requested', (p) => this.onClarificationRequested(p)],
      // Phase E: workflow plan + per-step progress (TODO checklist).
      ['workflow:plan_ready', (p) => this.onWorkflowPlanReady(p)],
      ['workflow:step_start', (p) => this.onWorkflowStepStart(p)],
      ['workflow:step_complete', (p) => this.onWorkflowStepComplete(p)],
    ]);

    // Events with specific state handlers
    for (const [event, handler] of handlers) {
      const unsub = this.bus.on(event, (payload) => {
        this.pushEventIfVisible(event, payload);
        handler(payload as Record<string, unknown>);
        this.incrementCounter(event);
        this.state.stateGeneration++;
      });
      this.unsubscribers.push(unsub);
    }

    // Events that only go to event log (no state handler)
    for (const event of LOG_ONLY_EVENTS) {
      const unsub = this.bus.on(event, (payload) => {
        this.pushEventIfVisible(event, payload);
        this.incrementCounter(event);
      });
      this.unsubscribers.push(unsub);
    }
  }

  private pushEventIfVisible(event: BusEventName, payload: unknown): void {
    if (isDefaultVisible(event)) {
      pushEvent(this.state, mapBusEvent(event, payload));
    }
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
    // Chat tab (PR #11): track the active session id so the Chat
    // view can show the most-recently-active session by default.
    const incomingSessionId = input.sessionId as string | undefined;
    if (incomingSessionId) {
      this.state.chatActiveSessionId = incomingSessionId;
      this.refreshChatState();
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

    // Chat tab (PR #11): refresh conversation snapshot whenever a task
    // completes — the conversation may have new entries (recordUserTurn /
    // recordAssistantTurn), and pendingClarifications may have changed
    // if the task ended in input-required.
    this.refreshChatState();

    this.state.dirty = true;
  }

  /**
   * Chat tab (PR #11): refresh the in-state conversation snapshot from
   * SessionManager. Best-effort — silently no-ops when sessionManager
   * is not exposed on the orchestrator (e.g., when the TUI is run with
   * a config that did not pass `sessionManager` into createOrchestrator).
   *
   * Strategy:
   *   1. Refresh the session list (newest first).
   *   2. If chatActiveSessionId is null, default to the most recently
   *      created session.
   *   3. Pull the conversation history + pending clarifications for
   *      the active session.
   *
   * Called from onTaskStart (when a new task names a session id) and
   * onTaskComplete (when conversation entries may have been recorded).
   */
  private refreshChatState(): void {
    const sm = this.orchestrator.sessionManager;
    if (!sm) return;

    try {
      const sessions = sm.listSessions();
      // Sort newest-first so the chat sidebar shows the most recent
      // session at the top.
      const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
      this.state.chatSessions = sorted.map((s) => ({
        id: s.id,
        source: s.source,
        status: s.status,
        createdAt: s.createdAt,
        messageCount: sm.getMessageCount(s.id),
      }));

      // Default the active session to the most recent one if none set.
      if (!this.state.chatActiveSessionId && sorted.length > 0) {
        this.state.chatActiveSessionId = sorted[0]!.id;
      }

      if (this.state.chatActiveSessionId) {
        const history = sm.getConversationHistory(this.state.chatActiveSessionId, 1_000_000);
        this.state.chatConversation = history.map((h) => ({
          role: h.role,
          content: h.content,
          timestamp: h.timestamp,
          taskId: h.taskId || undefined,
        }));
        this.state.chatPendingClarifications = sm.getPendingClarifications(
          this.state.chatActiveSessionId,
        );
      }
      this.state.dirty = true;
    } catch {
      // SessionManager / SQLite errors are best-effort — never crash
      // the TUI for an observability feature.
    }
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

  // ── Agent Session Handlers ──────────────────────────────────────

  private onAgentSessionStart(p: Record<string, unknown>): void {
    const taskId = String(p.taskId ?? '');
    if (!taskId) return;
    const budget = p.budget as { maxTokens?: number; maxTurns?: number } | undefined;
    this.state.activeSessions.set(taskId, {
      taskId,
      routingLevel: Number(p.routingLevel ?? 0),
      startedAt: Date.now(),
      turnsCompleted: 0,
      tokensConsumed: 0,
      turnsRemaining: budget?.maxTurns ?? 0,
    });
    this.state.dirty = true;
  }

  private onAgentSessionEnd(p: Record<string, unknown>): void {
    const taskId = String(p.taskId ?? '');
    this.state.activeSessions.delete(taskId);
    this.state.dirty = true;
  }

  private onAgentTurnComplete(p: Record<string, unknown>): void {
    const taskId = String(p.taskId ?? '');
    const session = this.state.activeSessions.get(taskId);
    if (!session) return;
    session.turnsCompleted += 1;
    session.tokensConsumed += Number(p.tokensConsumed ?? 0);
    session.turnsRemaining = Number(p.turnsRemaining ?? session.turnsRemaining);
    this.state.dirty = true;
  }

  private onAgentToolExecuted(p: Record<string, unknown>): void {
    const taskId = String(p.taskId ?? '');
    const session = this.state.activeSessions.get(taskId);
    if (!session) return;
    session.currentTool = String(p.toolName ?? '');
    session.lastToolAt = Date.now();
    this.state.dirty = true;
  }

  // ── Phase D: structured clarifications ──────────────────────────

  private onClarificationRequested(p: Record<string, unknown>): void {
    const structured = Array.isArray(p.structuredQuestions)
      ? (p.structuredQuestions as import('../../core/clarification.ts').ClarificationQuestion[])
      : [];
    const stringQuestions = Array.isArray(p.questions) ? (p.questions as string[]) : [];
    this.state.chatStructuredClarifications = structured;
    // Keep the legacy list in sync so older chat views still get something.
    if (stringQuestions.length > 0 || structured.length === 0) {
      this.state.chatPendingClarifications = stringQuestions;
    } else {
      this.state.chatPendingClarifications = structured.map((q) => q.prompt);
    }
    this.state.dirty = true;
  }

  // ── Phase E: workflow plan + step progress ──────────────────────

  private onWorkflowPlanReady(p: Record<string, unknown>): void {
    const taskId = String(p.taskId ?? '');
    const goal = String(p.goal ?? '');
    const rawSteps = Array.isArray(p.steps) ? p.steps : [];
    const steps = rawSteps.map((s) => {
      const step = s as Record<string, unknown>;
      return {
        id: String(step.id ?? ''),
        description: String(step.description ?? ''),
        strategy: String(step.strategy ?? ''),
        dependencies: Array.isArray(step.dependencies) ? (step.dependencies as string[]) : [],
      };
    });
    this.state.chatWorkflowPlan = { taskId, goal, steps };
    // Reset per-step status — every step starts 'pending'.
    this.state.chatWorkflowStepStatus = new Map(steps.map((s) => [s.id, 'pending'] as const));
    this.state.dirty = true;
  }

  private onWorkflowStepStart(p: Record<string, unknown>): void {
    const stepId = String(p.stepId ?? '');
    if (!stepId) return;
    this.state.chatWorkflowStepStatus.set(stepId, 'in-progress');
    this.state.dirty = true;
  }

  private onWorkflowStepComplete(p: Record<string, unknown>): void {
    const stepId = String(p.stepId ?? '');
    if (!stepId) return;
    const status = p.status === 'failed' ? 'failed' : 'completed';
    this.state.chatWorkflowStepStatus.set(stepId, status);
    this.state.dirty = true;
  }

  // ── Real-time Counters ──────────────────────────────────────────

  private incrementCounter(event: string): void {
    // Extract domain from event name (e.g. 'task:start' → 'task')
    const domain = event.split(':')[0] ?? 'other';
    this.state.realtimeCounters[domain] = (this.state.realtimeCounters[domain] ?? 0) + 1;
  }

  // ── Metrics Polling ─────────────────────────────────────────────

  private startMetricsPolling(): void {
    // Poll every 10s (was 5s) — metrics are expensive (20+ DB queries)
    this.metricsTimer = setInterval(() => this.refreshMetricsAsync(), 10_000);
  }

  /** Tick every 1s to keep clock and uptime fresh. */
  private startClockTick(): void {
    this.clockTimer = setInterval(() => {
      this.state.dirty = true;
    }, 1000);
  }

  /** Non-blocking metrics refresh. Yields to event loop between DB reads.
   *
   * Split into two deferred steps so each heavy sync SQLite batch (core metrics
   * then evolution report) gets its own event-loop tick — keeps the TUI
   * responsive during polling even as trace counts grow.
   */
  private refreshMetricsAsync(): void {
    // Guard: skip if previous refresh is still running
    if (this.metricsRunning) return;
    this.metricsRunning = true;

    // ── Step 1: core metrics (count + findRecent(100) + store counts) ──────
    setTimeout(() => {
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
          // skipEvolution=true keeps this step fast; evolution runs in step 2
          this.state.metrics = getSystemMetrics(deps, true);
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

      // ── Step 2: evolution report (findRecent(200) + rule/skill queries) ──
      setTimeout(() => {
        try {
          const { traceStore, ruleStore, skillStore, patternStore } = this.orchestrator;
          if (traceStore && this.state.metrics) {
            this.state.metrics = {
              ...this.state.metrics,
              evolution: generateEvolutionReport({ traceStore, ruleStore, skillStore, patternStore }),
            };
            this.state.dirty = true;
          }
        } catch {
          // Best-effort
        }

        // ── Step 3: economy data ──────────────────────────────────
        try {
          const { costLedger, budgetEnforcer } = this.orchestrator;
          if (costLedger || budgetEnforcer) {
            const budgetWindows = (budgetEnforcer?.checkBudget() ?? []).map((b) => ({
              label: b.window,
              spent: b.spent_usd,
              limit: b.limit_usd,
              pct: b.utilization_pct,
            }));
            const costHour = costLedger?.getAggregatedCost('hour');
            const costDay = costLedger?.getAggregatedCost('day');
            (this.state as TUIState & { economy?: import('../views/economy.ts').EconomyDisplayState }).economy = {
              budgetWindows,
              costHistory: [],
              totalCostUsd: costDay?.total_usd ?? 0,
              totalEntries: costLedger?.count() ?? 0,
              marketPhase: 'idle',
              marketEnabled: false,
              auctionCount: 0,
              engineTrust: [],
              federationEnabled: false,
            };
            this.state.dirty = true;
          }
        } catch {
          // Best-effort
        }

        this.metricsRunning = false;
      }, 0);
    }, 0);
  }
}
