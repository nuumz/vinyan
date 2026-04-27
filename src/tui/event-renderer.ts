/**
 * Event Renderer — renders VinyanBus events to terminal.
 *
 * Categorizes events and applies color/formatting per event type.
 */

import type { BusEventName, VinyanBus } from '../core/bus.ts';
import { ANSI, color, dim, formatTimestamp } from './renderer.ts';

export interface EventRendererConfig {
  /** Maximum number of events to keep in the rolling buffer. */
  maxEvents?: number;
  /** Filter to specific event categories (empty = all). */
  categories?: string[];
  /** Whether to show timestamps. */
  showTimestamps?: boolean;
}

interface RenderedEvent {
  timestamp: number;
  category: string;
  icon: string;
  summary: string;
  raw: { event: string; payload: unknown };
}

const EVENT_STYLES: Record<string, { icon: string; color: string; category: string }> = {
  'task:start': { icon: '>', color: ANSI.blue, category: 'task' },
  'task:complete': { icon: '+', color: ANSI.green, category: 'task' },
  'task:uncertain': { icon: '?', color: ANSI.yellow, category: 'task' },
  'task:escalate': { icon: '^', color: ANSI.magenta, category: 'task' },
  'task:timeout': { icon: '!', color: ANSI.red, category: 'task' },

  'oracle:verdict': { icon: 'o', color: ANSI.cyan, category: 'oracle' },
  'oracle:contradiction': { icon: '!', color: ANSI.red, category: 'oracle' },
  'oracle:deliberation_request': { icon: '?', color: ANSI.yellow, category: 'oracle' },

  'worker:dispatch': { icon: '*', color: ANSI.blue, category: 'worker' },
  'worker:complete': { icon: '+', color: ANSI.green, category: 'worker' },
  'worker:error': { icon: '!', color: ANSI.red, category: 'worker' },
  'worker:selected': { icon: '-', color: ANSI.blue, category: 'worker' },
  'profile:promoted': { icon: '^', color: ANSI.green, category: 'worker' },
  'profile:demoted': { icon: 'v', color: ANSI.red, category: 'worker' },
  'profile:reactivated': { icon: '↻', color: ANSI.yellow, category: 'worker' },
  'profile:retired': { icon: 'x', color: ANSI.red, category: 'worker' },

  'evolution:rulePromoted': { icon: '*', color: ANSI.green, category: 'evolution' },
  'evolution:ruleRetired': { icon: '-', color: ANSI.yellow, category: 'evolution' },
  'evolution:capabilityPromoted': { icon: '+', color: ANSI.green, category: 'evolution' },

  'sleep:cycleComplete': { icon: 'z', color: ANSI.magenta, category: 'sleep' },

  'peer:connected': { icon: '<>', color: ANSI.green, category: 'network' },
  'peer:disconnected': { icon: '>|', color: ANSI.red, category: 'network' },

  'a2a:knowledgeImported': { icon: '<-', color: ANSI.cyan, category: 'knowledge' },
  'a2a:knowledgeOffered': { icon: '->', color: ANSI.cyan, category: 'knowledge' },

  'guardrail:violation': { icon: '!!', color: ANSI.red, category: 'security' },
  // Book-integration Wave 1.1: worker-level silence watchdog. Yellow for
  // `silent` (recoverable warning) and red for `stalled` (forcible kill
  // recommended). Category sits under `worker` because it's about one
  // agent subprocess, not a system-wide security event.
  'guardrail:silent_agent': { icon: 'zZ', color: ANSI.yellow, category: 'worker' },
  'api:request': { icon: '->', color: ANSI.gray, category: 'api' },
  'api:response': { icon: '<-', color: ANSI.gray, category: 'api' },
};

function getStyle(event: string): { icon: string; color: string; category: string } {
  return EVENT_STYLES[event] ?? { icon: '·', color: ANSI.gray, category: 'other' };
}

function summarizePayload(event: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  switch (event) {
    case 'task:start':
      return `routing=${p.routing ?? '?'}`;
    case 'task:complete':
      return `mutations=${(p.result as { mutations?: unknown[] })?.mutations?.length ?? 0}`;
    case 'task:uncertain':
      return `reason="${String(p.reason ?? '').slice(0, 50)}"`;
    case 'oracle:verdict':
      return `oracle=${p.oracleName ?? '?'} verified=${(p.verdict as Record<string, unknown>)?.verified ?? '?'}`;
    case 'worker:selected':
      return `worker=${p.workerId ?? '?'} score=${p.score ?? '?'}`;
    case 'worker:error':
      return `error="${String(p.error ?? '').slice(0, 50)}"`;
    case 'sleep:cycleComplete':
      return `patterns=${p.patternsFound ?? 0} rules=${p.rulesGenerated ?? 0} caps=${p.capabilitiesPromoted ?? 0}`;
    case 'evolution:capabilityPromoted':
      return `agent=${p.agentId ?? '?'} capability=${p.capabilityId ?? '?'} confidence=${p.confidence ?? '?'}`;
    case 'peer:connected':
      return `peer=${p.peerId ?? '?'}`;
    case 'a2a:knowledgeImported':
      return `from=${p.peerId ?? '?'} patterns=${p.patternsImported ?? 0}`;
    case 'guardrail:silent_agent':
      return `task=${p.taskId ?? '?'} state=${p.state ?? '?'} for=${p.silentForMs ?? 0}ms lastEvent=${p.lastEvent ?? '?'}`;
    default:
      return JSON.stringify(payload).slice(0, 60);
  }
}

export class EventRenderer {
  private events: RenderedEvent[] = [];
  private maxEvents: number;
  private unsubscribers: Array<() => void> = [];
  private config: EventRendererConfig;

  constructor(config: EventRendererConfig = {}) {
    this.maxEvents = config.maxEvents ?? 200;
    this.config = config;
  }

  /** Subscribe to all events on a bus and render them. */
  attach(bus: VinyanBus): void {
    // Subscribe to a known set of common events
    const eventNames: BusEventName[] = [
      'task:start',
      'task:complete',
      'task:uncertain',
      'task:escalate',
      'task:timeout',
      'oracle:verdict',
      'oracle:contradiction',
      'oracle:deliberation_request',
      'worker:dispatch',
      'worker:complete',
      'worker:error',
      'worker:selected',
      'profile:promoted',
      'profile:demoted',
      'profile:reactivated',
      'profile:retired',
      'evolution:rulePromoted',
      'evolution:ruleRetired',
      'evolution:capabilityPromoted',
      'sleep:cycleComplete',
      'peer:connected',
      'peer:disconnected',
      'a2a:knowledgeImported',
      'a2a:knowledgeOffered',
      'guardrail:violation',
      // Book-integration Wave 1.1: surface the per-worker silence
      // watchdog in the default watch view so operators see it without
      // needing to switch to `vinyan tui peek`.
      'guardrail:silent_agent',
      'api:request',
      'api:response',
    ];

    for (const eventName of eventNames) {
      const unsub = bus.on(eventName, (payload) => {
        this.handleEvent(eventName, payload);
      });
      this.unsubscribers.push(unsub);
    }
  }

  /** Detach from bus events. */
  detach(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  /** Process and render a single event. */
  private handleEvent(event: string, payload: unknown): void {
    const style = getStyle(event);

    // Category filter
    if (this.config.categories?.length && !this.config.categories.includes(style.category)) {
      return;
    }

    const rendered: RenderedEvent = {
      timestamp: Date.now(),
      category: style.category,
      icon: style.icon,
      summary: summarizePayload(event, payload),
      raw: { event, payload },
    };

    this.events.push(rendered);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Render to terminal
    const ts = this.config.showTimestamps !== false ? `${dim(formatTimestamp(rendered.timestamp))} ` : '';
    const eventTag = color(event.padEnd(25), style.color);
    console.log(`${ts}${style.icon} ${eventTag} ${rendered.summary}`);
  }

  /** Get all captured events (for replay/export). */
  getEvents(): ReadonlyArray<RenderedEvent> {
    return this.events;
  }

  /** Clear the event buffer. */
  clear(): void {
    this.events = [];
  }
}
