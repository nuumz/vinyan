/**
 * Remote Bus Adapter — forward configured bus events to A2A peers.
 *
 * Subscribes to selected VinyanBus events and sends them to peers
 * as ECP data parts via A2A tasks/send. Fire-and-forget delivery.
 *
 * Source of truth: Plan Phase L3
 */
import type { BusEventName, EventBus, VinyanBusEvents } from '../core/bus.ts';
import { ECP_MIME_TYPE } from './ecp-data-part.ts';

// ── Configuration ─────────────────────────────────────────────────────

export interface RemoteBusConfig {
  bus: EventBus<VinyanBusEvents>;
  peerUrls: string[];
  instanceId: string;
  /** Override the default forwarded events. */
  forwardedEvents?: BusEventName[];
}

/** Events safe and useful to forward to peers. */
export const DEFAULT_FORWARDED_EVENTS: BusEventName[] = [
  'sleep:cycleComplete',
  'evolution:rulePromoted',
  'evolution:ruleRetired',
  'skill:outcome',
  'file:hashChanged',
];

/** Events that must NEVER be forwarded (internal-only). */
const NEVER_FORWARDED: ReadonlySet<string> = new Set([
  'worker:dispatch',
  'trace:record',
  'task:start',
  'task:complete',
]);

// ── Adapter ───────────────────────────────────────────────────────────

export class RemoteBusAdapter {
  private unsubs: Array<() => void> = [];
  private readonly forwardedEvents: BusEventName[];

  constructor(private config: RemoteBusConfig) {
    this.forwardedEvents = (config.forwardedEvents ?? DEFAULT_FORWARDED_EVENTS).filter((e) => !NEVER_FORWARDED.has(e));
  }

  /** Start forwarding events to peers. */
  start(): void {
    for (const event of this.forwardedEvents) {
      const unsub = this.config.bus.on(event, (payload: unknown) => {
        void this.forwardToPeers(event, payload);
      });
      this.unsubs.push(unsub);
    }
  }

  /** Stop forwarding. */
  stop(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /** Get the list of events being forwarded. */
  getForwardedEvents(): BusEventName[] {
    return [...this.forwardedEvents];
  }

  private async forwardToPeers(event: string, payload: unknown): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `remote-bus-${Date.now()}`,
      method: 'tasks/send',
      params: {
        id: `bus-${event}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        message: {
          role: 'agent',
          parts: [
            {
              type: 'data',
              mimeType: ECP_MIME_TYPE,
              data: {
                ecp_version: 1,
                message_type: 'knowledge_transfer',
                epistemic_type: 'known',
                confidence: 1.0,
                confidence_reported: true,
                payload: {
                  bus_event: event,
                  data: payload,
                  instance_id: this.config.instanceId,
                  timestamp: Date.now(),
                },
              },
            },
          ],
        },
      },
    });

    await Promise.allSettled(
      this.config.peerUrls.map(async (peerUrl) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          await fetch(peerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
          });
          clearTimeout(timer);
        } catch {
          // Fire-and-forget
        }
      }),
    );
  }
}
