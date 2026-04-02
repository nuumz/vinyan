/**
 * TUI Types — shared type definitions for the interactive terminal UI.
 */

import type { HealthCheck } from '../observability/health.ts';
import type { SystemMetrics } from '../observability/metrics.ts';
import type { PeerTrustLevel } from '../oracle/tier-clamp.ts';

// ── View / Navigation ───────────────────────────────────────────────

export type ViewTab = 'dashboard' | 'tasks' | 'peers';
export type InputMode = 'normal' | 'command' | 'filter';

// ── Event Log ───────────────────────────────────────────────────────

export type EventDomain =
  | 'task'
  | 'worker'
  | 'oracle'
  | 'evolve'
  | 'skill'
  | 'sleep'
  | 'shadow'
  | 'guard'
  | 'peer'
  | 'pipeline'
  | 'fleet'
  | 'system'
  | 'api'
  | 'other';

export interface EventLogEntry {
  id: number;
  timestamp: number;
  domain: EventDomain;
  event: string;
  summary: string;
  icon: string;
  colorCode: string;
  payload: unknown;
}

// ── Task Display ────────────────────────────────────────────────────

export type PipelineStep = 'perceive' | 'predict' | 'plan' | 'generate' | 'verify' | 'learn';
export type PipelineStepStatus = 'pending' | 'running' | 'done' | 'skipped';

export interface TaskDisplayState {
  id: string;
  goal: string;
  source: string;
  routingLevel: number;
  status: 'running' | 'completed' | 'failed' | 'escalated' | 'uncertain' | 'approval_required';
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  qualityScore?: number;
  workerId?: string;
  riskScore?: number;
  pipeline: Record<PipelineStep, PipelineStepStatus>;
  oracleVerdicts: Array<{ name: string; verified: boolean; confidence: number }>;
  pendingApproval?: {
    riskScore: number;
    reason: string;
  };
}

// ── Peer Display ────────────────────────────────────────────────────

export interface PeerDisplayState {
  peerId: string;
  instanceId: string;
  url: string;
  trustLevel: PeerTrustLevel;
  healthState: 'connected' | 'degraded' | 'partitioned' | 'unknown';
  latencyMs?: number;
  interactions: number;
  lastSeen: number;
  capabilities: string[];
  knowledgeImported: number;
  knowledgeOffered: number;
}

// ── Modal ───────────────────────────────────────────────────────────

export type ModalType = 'approval' | 'help' | 'confirm-quit';

export interface ModalState {
  type: ModalType;
  taskId?: string;
  riskScore?: number;
  reason?: string;
}

// ── TUI State ───────────────────────────────────────────────────────

export interface TUIState {
  // View
  activeTab: ViewTab;
  focusedPanel: number;
  inputMode: InputMode;
  commandBuffer: string;
  filterQuery: string;
  modal: ModalState | null;

  // Data
  health: HealthCheck | null;
  metrics: SystemMetrics | null;
  eventLog: EventLogEntry[];
  eventLogMaxSize: number;
  eventIdCounter: number;

  // Tasks
  tasks: Map<string, TaskDisplayState>;
  selectedTaskId: string | null;

  // Peers
  peers: Map<string, PeerDisplayState>;
  selectedPeerId: string | null;

  // Terminal
  termWidth: number;
  termHeight: number;
  startedAt: number;
  dirty: boolean;

  // Scroll positions
  eventLogScroll: number;
  taskListScroll: number;
  peerListScroll: number;
}
