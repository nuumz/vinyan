/**
 * Event Mapper — maps VinyanBus events to TUI display entries.
 *
 * Classifies events by domain, assigns icons and colors,
 * and generates human-readable summaries.
 */

import { ANSI } from '../renderer.ts';
import type { EventDomain, EventLogEntry } from '../types.ts';

interface EventStyle {
  domain: EventDomain;
  icon: string;
  color: string;
  defaultVisible: boolean;
}

const EVENT_MAP: Record<string, EventStyle> = {
  // Task lifecycle — always visible
  'task:start': { domain: 'task', icon: '▶', color: ANSI.blue, defaultVisible: true },
  'task:complete': { domain: 'task', icon: '✓', color: ANSI.green, defaultVisible: true },
  'task:escalate': { domain: 'task', icon: '↑', color: ANSI.magenta, defaultVisible: true },
  'task:timeout': { domain: 'task', icon: '⏱', color: ANSI.red, defaultVisible: true },
  'task:approval_required': { domain: 'task', icon: '⚠', color: ANSI.yellow, defaultVisible: true },
  'task:explore': { domain: 'task', icon: 'ε', color: ANSI.cyan, defaultVisible: false },
  'task:uncertain': { domain: 'task', icon: '?', color: ANSI.yellow, defaultVisible: true },

  // Worker
  'worker:dispatch': { domain: 'worker', icon: '→', color: ANSI.blue, defaultVisible: false },
  'worker:complete': { domain: 'worker', icon: '←', color: ANSI.green, defaultVisible: false },
  'worker:error': { domain: 'worker', icon: '✗', color: ANSI.red, defaultVisible: true },
  // Unified profile lifecycle — TUI filters by kind when rendering to the worker domain
  'profile:registered': { domain: 'worker', icon: '+', color: ANSI.green, defaultVisible: false },
  'profile:promoted': { domain: 'worker', icon: '↑', color: ANSI.green, defaultVisible: true },
  'profile:demoted': { domain: 'worker', icon: '↓', color: ANSI.red, defaultVisible: true },
  'profile:reactivated': { domain: 'worker', icon: '↻', color: ANSI.yellow, defaultVisible: true },
  'profile:retired': { domain: 'worker', icon: '✗', color: ANSI.red, defaultVisible: true },
  'worker:selected': { domain: 'worker', icon: '·', color: ANSI.blue, defaultVisible: false },
  'worker:exploration': { domain: 'worker', icon: 'ε', color: ANSI.cyan, defaultVisible: false },

  // Oracle
  'oracle:verdict': { domain: 'oracle', icon: '⊙', color: ANSI.cyan, defaultVisible: false },
  'oracle:contradiction': { domain: 'oracle', icon: '⚡', color: ANSI.red, defaultVisible: true },
  'oracle:deliberation_request': { domain: 'oracle', icon: '?', color: ANSI.yellow, defaultVisible: true },

  // Evolution
  'evolution:rulesApplied': { domain: 'evolve', icon: '·', color: ANSI.gray, defaultVisible: false },
  'evolution:rulePromoted': { domain: 'evolve', icon: '★', color: ANSI.green, defaultVisible: true },
  'evolution:ruleRetired': { domain: 'evolve', icon: '✗', color: ANSI.yellow, defaultVisible: true },

  // Skills
  'skill:match': { domain: 'skill', icon: '⚡', color: ANSI.green, defaultVisible: false },
  'skill:miss': { domain: 'skill', icon: '·', color: ANSI.gray, defaultVisible: false },
  'skill:outcome': { domain: 'skill', icon: '·', color: ANSI.cyan, defaultVisible: false },

  // Sleep cycle
  'sleep:cycleComplete': { domain: 'sleep', icon: '☾', color: ANSI.magenta, defaultVisible: true },

  // Shadow
  'shadow:enqueue': { domain: 'shadow', icon: '▸', color: ANSI.gray, defaultVisible: false },
  'shadow:complete': { domain: 'shadow', icon: '✓', color: ANSI.green, defaultVisible: false },
  'shadow:failed': { domain: 'shadow', icon: '✗', color: ANSI.red, defaultVisible: true },

  // Guardrails — always visible (security)
  'guardrail:injection_detected': { domain: 'guard', icon: '🛡', color: ANSI.red, defaultVisible: true },
  'guardrail:bypass_detected': { domain: 'guard', icon: '🛡', color: ANSI.red, defaultVisible: true },
  'guardrail:violation': { domain: 'guard', icon: '🛡', color: ANSI.red, defaultVisible: true },

  // Peer / A2A — always visible
  'peer:connected': { domain: 'peer', icon: '⇌', color: ANSI.green, defaultVisible: true },
  'peer:disconnected': { domain: 'peer', icon: '⇎', color: ANSI.red, defaultVisible: true },
  'peer:trustChanged': { domain: 'peer', icon: '⊕', color: ANSI.yellow, defaultVisible: true },
  'a2a:verdictReceived': { domain: 'peer', icon: '←', color: ANSI.cyan, defaultVisible: false },
  'a2a:knowledgeImported': { domain: 'peer', icon: '←', color: ANSI.cyan, defaultVisible: true },
  'a2a:knowledgeOffered': { domain: 'peer', icon: '→', color: ANSI.cyan, defaultVisible: false },
  'a2a:knowledgeAccepted': { domain: 'peer', icon: '✓', color: ANSI.green, defaultVisible: false },
  'a2a:capabilityUpdated': { domain: 'peer', icon: '↻', color: ANSI.blue, defaultVisible: false },
  'a2a:intentDeclared': { domain: 'peer', icon: '⊳', color: ANSI.blue, defaultVisible: false },
  'a2a:intentConflict': { domain: 'peer', icon: '⚡', color: ANSI.red, defaultVisible: true },
  'a2a:proposalReceived': { domain: 'peer', icon: '⊲', color: ANSI.blue, defaultVisible: false },
  'a2a:commitmentFailed': { domain: 'peer', icon: '✗', color: ANSI.red, defaultVisible: true },
  'a2a:retractionReceived': { domain: 'peer', icon: '↩', color: ANSI.yellow, defaultVisible: true },
  'a2a:feedbackReceived': { domain: 'peer', icon: '◎', color: ANSI.cyan, defaultVisible: false },

  // Pipeline confidence — always visible (decisions)
  'pipeline:re-verify': { domain: 'pipeline', icon: '↻', color: ANSI.yellow, defaultVisible: true },
  'pipeline:escalate': { domain: 'pipeline', icon: '↑', color: ANSI.magenta, defaultVisible: true },
  'pipeline:refuse': { domain: 'pipeline', icon: '✗', color: ANSI.red, defaultVisible: true },

  // Fleet governance
  'fleet:convergence_warning': { domain: 'fleet', icon: '⚠', color: ANSI.yellow, defaultVisible: true },
  'fleet:emergency_reactivation': { domain: 'fleet', icon: '↻', color: ANSI.yellow, defaultVisible: true },
  'fleet:diversity_enforced': { domain: 'fleet', icon: '⊕', color: ANSI.blue, defaultVisible: true },

  // System health
  'circuit:open': { domain: 'system', icon: '⊘', color: ANSI.red, defaultVisible: true },
  'circuit:close': { domain: 'system', icon: '⊙', color: ANSI.green, defaultVisible: true },
  'observability:alert': { domain: 'system', icon: '⚠', color: ANSI.red, defaultVisible: true },
  'memory:eviction_warning': { domain: 'system', icon: '⚠', color: ANSI.yellow, defaultVisible: true },
  'context:verdict_omitted': { domain: 'system', icon: '⊘', color: ANSI.yellow, defaultVisible: true },
  'selfmodel:predict': { domain: 'system', icon: '·', color: ANSI.gray, defaultVisible: false },
  'selfmodel:calibration_error': { domain: 'system', icon: '⚠', color: ANSI.yellow, defaultVisible: true },
  'selfmodel:systematic_miscalibration': { domain: 'system', icon: '⚠', color: ANSI.red, defaultVisible: true },
  'commit:rejected': { domain: 'system', icon: '✗', color: ANSI.red, defaultVisible: true },

  // API (hidden by default)
  'api:request': { domain: 'api', icon: '→', color: ANSI.gray, defaultVisible: false },
  'api:response': { domain: 'api', icon: '←', color: ANSI.gray, defaultVisible: false },
  'session:created': { domain: 'api', icon: '+', color: ANSI.gray, defaultVisible: false },
  'session:compacted': { domain: 'api', icon: '~', color: ANSI.gray, defaultVisible: false },

  // File/graph
  'file:hashChanged': { domain: 'system', icon: '~', color: ANSI.gray, defaultVisible: false },
  'graph:fact': { domain: 'system', icon: '·', color: ANSI.gray, defaultVisible: false },
  'trace:record': { domain: 'system', icon: '·', color: ANSI.gray, defaultVisible: false },
  'critic:verdict': { domain: 'oracle', icon: '⊙', color: ANSI.cyan, defaultVisible: false },
  'tools:executed': { domain: 'system', icon: '⚙', color: ANSI.gray, defaultVisible: false },
  'decomposer:fallback': { domain: 'system', icon: '↩', color: ANSI.yellow, defaultVisible: true },

  // Economy OS
  'economy:cost_recorded': { domain: 'system', icon: '$', color: ANSI.gray, defaultVisible: false },
  'economy:budget_warning': { domain: 'system', icon: '⚠', color: ANSI.yellow, defaultVisible: true },
  'economy:budget_exceeded': { domain: 'system', icon: '✗', color: ANSI.red, defaultVisible: true },
  'economy:budget_degraded': { domain: 'system', icon: '↓', color: ANSI.yellow, defaultVisible: true },
  'economy:cost_pattern_detected': { domain: 'system', icon: '◉', color: ANSI.cyan, defaultVisible: true },
  'market:auction_started': { domain: 'system', icon: '⊕', color: ANSI.blue, defaultVisible: false },
  'market:auction_completed': { domain: 'system', icon: '⊕', color: ANSI.green, defaultVisible: true },
  'market:phase_transition': { domain: 'system', icon: '→', color: ANSI.magenta, defaultVisible: true },
  'market:auto_activated': { domain: 'system', icon: '▶', color: ANSI.green, defaultVisible: true },
  'market:settlement_accurate': { domain: 'system', icon: '✓', color: ANSI.green, defaultVisible: false },
  'market:settlement_inaccurate': { domain: 'system', icon: '✗', color: ANSI.red, defaultVisible: true },
  'market:fallback_to_selector': { domain: 'system', icon: '↩', color: ANSI.yellow, defaultVisible: false },
  'human:review_requested': { domain: 'system', icon: '⚠', color: ANSI.yellow, defaultVisible: true },
  'human:review_completed': { domain: 'system', icon: '✓', color: ANSI.green, defaultVisible: true },
  'engine:selected': { domain: 'system', icon: '⊙', color: ANSI.blue, defaultVisible: false },
};

const DEFAULT_STYLE: EventStyle = { domain: 'other', icon: '·', color: ANSI.gray, defaultVisible: false };

export function getEventStyle(event: string): EventStyle {
  return EVENT_MAP[event] ?? DEFAULT_STYLE;
}

export function isDefaultVisible(event: string): boolean {
  return (EVENT_MAP[event] ?? DEFAULT_STYLE).defaultVisible;
}

/** Generate a human-readable summary for an event payload. */
export function summarizeEvent(event: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  switch (event) {
    case 'task:start': {
      const input = p.input as Record<string, unknown> | undefined;
      const routing = p.routing as Record<string, unknown> | undefined;
      return `L${routing?.level ?? '?'} ${truncStr(String(input?.goal ?? ''), 50)}`;
    }
    case 'task:complete': {
      const result = p.result as Record<string, unknown> | undefined;
      const qs = result?.qualityScore;
      const composite = typeof qs === 'object' && qs !== null ? (qs as Record<string, unknown>).composite : qs;
      const qNum = typeof composite === 'number' && !Number.isNaN(composite) ? composite : null;
      const qStr = qNum != null ? `q=${qNum.toFixed(2)}` : '';
      const trace = result?.trace as Record<string, unknown> | undefined;
      const tokens = trace?.tokensConsumed;
      const tStr = typeof tokens === 'number' && tokens > 0 ? `${tokens}tok` : '';
      return `${result?.status ?? '?'} ${qStr} ${tStr}`.trim();
    }
    case 'task:escalate':
      return `L${p.fromLevel}→L${p.toLevel} ${truncStr(String(p.reason ?? ''), 40)}`;
    case 'task:timeout':
      return `${p.elapsedMs}ms / ${p.budgetMs}ms`;
    case 'task:approval_required':
      return `risk=${fmtNum(p.riskScore)} ${truncStr(String(p.reason ?? ''), 40)}`;
    case 'task:uncertain':
      return truncStr(String(p.reason ?? ''), 50);
    case 'oracle:verdict': {
      const v = p.verdict as Record<string, unknown> | undefined;
      return `${p.oracleName}: ${v?.verified ? 'PASS' : 'FAIL'} (${fmtNum(v?.confidence)})`;
    }
    case 'oracle:contradiction':
      return `pass=[${(p.passed as string[])?.join(',')}] fail=[${(p.failed as string[])?.join(',')}]`;
    case 'worker:dispatch':
      return `task=${truncStr(String(p.taskId ?? ''), 12)}`;
    case 'worker:complete':
      return `task=${truncStr(String(p.taskId ?? ''), 12)} ${p.durationMs}ms`;
    case 'worker:error':
      return truncStr(String(p.error ?? ''), 50);
    case 'profile:promoted':
      return `${p.id} ${truncStr(String(p.reason ?? ''), 40)}`;
    case 'profile:demoted':
      return `${p.id} ${truncStr(String(p.reason ?? ''), 30)}${p.permanent ? ' [retired]' : ''}`;
    case 'profile:reactivated':
      return `${p.id}${p.emergency ? ' [emergency]' : ''}`;
    case 'profile:retired':
      return `${p.id} ${truncStr(String(p.reason ?? ''), 30)}`;
    case 'profile:registered':
      return `${p.kind} ${p.id}`;
    case 'worker:selected':
      return `${p.workerId} score=${fmtNum(p.score)}`;
    case 'sleep:cycleComplete':
      return `patterns=${p.patternsFound} rules=${p.rulesGenerated} skills=${p.skillsCreated}`;
    case 'evolution:rulePromoted':
      return `${p.ruleId}`;
    case 'evolution:ruleRetired':
      return `${p.ruleId} ${truncStr(String(p.reason ?? ''), 30)}`;
    case 'peer:connected':
      return `${p.peerId} ${p.url}`;
    case 'peer:disconnected':
      return `${p.peerId} ${truncStr(String(p.reason ?? ''), 30)}`;
    case 'peer:trustChanged':
      return `${p.peerId} ${p.from}→${p.to}`;
    case 'a2a:knowledgeImported':
      return `from=${p.peerId} patterns=${p.patternsImported}`;
    case 'circuit:open':
      return `${p.oracleName} failures=${p.failureCount}`;
    case 'circuit:close':
      return `${p.oracleName} recovered`;
    case 'guardrail:injection_detected':
    case 'guardrail:bypass_detected':
      return `field=${p.field}`;
    case 'observability:alert':
      return `[${p.severity}] ${p.detector}: ${truncStr(String(p.message ?? ''), 40)}`;
    case 'pipeline:refuse':
      return `conf=${fmtNum(p.composite)} ${truncStr(String(p.reason ?? ''), 30)}`;
    default:
      return truncStr(JSON.stringify(payload), 50);
  }
}

/** Create an EventLogEntry from an event name and payload. */
export function mapBusEvent(event: string, payload: unknown): Omit<EventLogEntry, 'id'> {
  const style = getEventStyle(event);
  return {
    timestamp: Date.now(),
    domain: style.domain,
    event,
    summary: summarizeEvent(event, payload),
    icon: style.icon,
    colorCode: style.color,
    payload,
  };
}

function truncStr(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtNum(v: unknown): string {
  if (typeof v === 'number' && !Number.isNaN(v)) return v.toFixed(2);
  return '?';
}
