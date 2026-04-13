/**
 * TUI Types — shared type definitions for the interactive terminal UI.
 */

import type { HealthCheck } from '../observability/health.ts';
import type { SystemMetrics } from '../observability/metrics.ts';
import type { PeerTrustLevel } from '../oracle/tier-clamp.ts';

// ── View / Navigation ───────────────────────────────────────────────

export type ViewTab = 'tasks' | 'system' | 'peers' | 'events' | 'economy' | 'chat';

/**
 * Chat (PR #11) — read-only conversation entry for the TUI Chat tab.
 * Mirrors the SessionManager's ConversationEntry shape but kept as a
 * TUI-local type so the TUI module does not depend on the api layer
 * directly. The DataSource is responsible for converting between the
 * two when populating state.
 */
export interface ChatMessageEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Optional task id linkage for the "View Task" navigation. */
  taskId?: string;
}

export interface ChatSessionSummary {
  id: string;
  source: string;
  status: string;
  createdAt: number;
  messageCount: number;
}
export type InputMode = 'normal' | 'command' | 'filter';

// ── Notifications & Feedback ────────────────────────────────────────

export type NotificationType = 'approval' | 'guardrail' | 'circuit' | 'alert';

export interface NotificationEntry {
  id: number;
  type: NotificationType;
  taskId?: string;
  message: string;
  priority: number; // 1 = highest (approval), 4 = lowest (alert)
  timestamp: number;
  dismissed: boolean;
}

export interface ToastMessage {
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
  expiresAt: number;
}

export interface BootLogEntry {
  message: string;
  level: 'log' | 'warn' | 'error';
  timestamp: number;
}

// ── Sort ────────────────────────────────────────────────────────────

export type SortField = 'startedAt' | 'status' | 'routingLevel' | 'quality';
export type PeerSortField = 'trust' | 'health' | 'lastSeen';
export type EventSortField = 'timestamp' | 'domain';

export interface SortConfig<F = SortField> {
  field: F;
  direction: 'asc' | 'desc';
}

// ── Tab Badges ──────────────────────────────────────────────────────

export interface TabBadge {
  count: number;
  color?: 'red' | 'yellow' | 'green';
}

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
  status: 'running' | 'completed' | 'failed' | 'escalated' | 'uncertain' | 'approval_required' | 'input-required';
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

export type ModalType = 'approval' | 'help' | 'confirm-quit' | 'confirm-cancel';

export interface ModalState {
  type: ModalType;
  taskId?: string;
  riskScore?: number;
  reason?: string;
}

// ── Active Agent Sessions (Phase 6) ─────────────────────────────────

export interface ActiveSessionState {
  taskId: string;
  routingLevel: number;
  startedAt: number;
  turnsCompleted: number;
  tokensConsumed: number;
  turnsRemaining: number;
  currentTool?: string;
  lastToolAt?: number;
  outcome?: string;
}

// ── TUI State ───────────────────────────────────────────────────────

export interface TUIState {
  // View
  activeTab: ViewTab;
  focusedPanel: number;
  inputMode: InputMode;
  commandBuffer: string;
  filterQuery: string;
  tabFilters: Partial<Record<ViewTab, string>>;
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

  // Chat (PR #11) — Agent Conversation read-only viewer
  chatActiveSessionId: string | null;
  chatConversation: ChatMessageEntry[];
  chatPendingClarifications: string[];
  chatSessions: ChatSessionSummary[];
  chatScroll: number;

  // History (for sparklines)
  successHistory: number[];

  // Terminal
  termWidth: number;
  termHeight: number;
  startedAt: number;
  dirty: boolean;
  stateGeneration: number;

  // Scroll positions
  eventLogScroll: number;
  eventDetailScroll: number;
  taskListScroll: number;
  peerListScroll: number;

  // Notifications & Feedback
  notifications: NotificationEntry[];
  notificationIdCounter: number;
  notificationIndex: number; // which notification is currently displayed
  toasts: ToastMessage[];
  tabBadges: Partial<Record<ViewTab, TabBadge>>;

  // Events tab
  selectedEventId: number | null;
  lastEventTabVisit: number; // eventIdCounter at last Events tab visit

  // Sorting
  sort: Partial<Record<ViewTab, SortConfig>>;

  // Real-time counters from MetricsCollector
  realtimeCounters: Record<string, number>;

  // Active agent sessions (Phase 6)
  activeSessions: Map<string, ActiveSessionState>;

  // Workspace path (for dbPath derivation)
  workspace: string;

  // Loading state — TUI renders immediately, data arrives later
  loading: boolean;
  loadingMessage: string;

  // Boot log — captured console output during initialization
  bootLog: BootLogEntry[];
}
