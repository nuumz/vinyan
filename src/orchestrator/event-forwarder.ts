/**
 * Event Forwarder — subscribes to configurable bus events and forwards
 * them to connected peer instances via A2A transport.
 *
 * Advisory only — peers may ignore forwarded events.
 * A3: Deterministic forwarding rules, no LLM in the path.
 *
 * Source of truth: design/implementation-plan.md §PH5.8
 */

import { A2ATransport } from '../a2a/a2a-transport.ts';
import type { DiscoveredPeer } from '../a2a/peer-discovery.ts';
import type { BusEventName, VinyanBus } from '../core/bus.ts';

export interface EventForwarderConfig {
  /** Event bus to subscribe to. */
  bus: VinyanBus;
  /** Local instance ID. */
  instanceId: string;
  /** Events to forward (default: sleep:cycleComplete, evolution:rulePromoted, skill:outcome). */
  forwardEvents?: BusEventName[];
  /** Function to get current active peers. */
  getPeers: () => DiscoveredPeer[];
  /** Timeout for forwarding in ms (default: 5000). */
  forwardTimeoutMs?: number;
}

const DEFAULT_FORWARD_EVENTS: BusEventName[] = ['sleep:cycleComplete', 'evolution:rulePromoted', 'skill:outcome'];

export class EventForwarder {
  private config: EventForwarderConfig;
  private unsubscribers: Array<() => void> = [];
  private forwardEvents: BusEventName[];
  private forwardTimeoutMs: number;

  constructor(config: EventForwarderConfig) {
    this.config = config;
    this.forwardEvents = config.forwardEvents ?? DEFAULT_FORWARD_EVENTS;
    this.forwardTimeoutMs = config.forwardTimeoutMs ?? 5000;
  }

  /** Start listening to configured events and forwarding to peers. */
  start(): void {
    for (const eventName of this.forwardEvents) {
      const unsub = this.config.bus.on(eventName, (payload: unknown) => {
        this.forwardToPeers(eventName, payload);
      });
      this.unsubscribers.push(unsub);
    }
  }

  /** Stop all event subscriptions. */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /** Forward a specific event to all peers. Used by broadcastVerdict(). */
  forward(event: string, payload: unknown): void {
    this.forwardToPeers(event, payload);
  }

  /** Get the list of events being forwarded. */
  getForwardedEvents(): BusEventName[] {
    return [...this.forwardEvents];
  }

  // ── Internal ──────────────────────────────────────────────────

  private forwardToPeers(event: string, payload: unknown): void {
    const peers = this.config.getPeers();

    for (const peer of peers) {
      this.forwardToPeer(peer, event, payload).catch(() => {
        // Best-effort — failure doesn't block local processing
      });
    }
  }

  private async forwardToPeer(peer: DiscoveredPeer, event: string, payload: unknown): Promise<void> {
    const transport = new A2ATransport({
      peerUrl: peer.url,
      oracleName: 'event-forward',
      instanceId: this.config.instanceId,
    });

    let success = false;
    try {
      await transport.verify(
        {
          target: `event:${event}`,
          pattern: 'event-forward',
          workspace: '',
          context: {
            event,
            payload,
            sourceInstanceId: this.config.instanceId,
            timestamp: Date.now(),
          },
        },
        this.forwardTimeoutMs,
      );
      success = true;
    } catch {
      success = false;
    }

    this.config.bus.emit('instance:eventForwarded', {
      event,
      peerId: peer.url,
      success,
    });
  }
}
