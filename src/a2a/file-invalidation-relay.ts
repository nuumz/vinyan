/**
 * File Invalidation Relay — Tier 0 real-time hash change propagation.
 *
 * Subscribes to `file:hashChanged` bus events and forwards them to peers
 * via A2A tasks/send with ECP `knowledge_transfer` data parts.
 * Fire-and-forget: failures are logged but not retried (Tier 0 = best-effort).
 *
 * Source of truth: Plan Phase E1
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import { wrapAsA2ADataPart } from './ecp-a2a-translation.ts';
import type { ECPDataPart } from './ecp-data-part.ts';

export interface FileInvalidationRelayConfig {
  bus: EventBus<VinyanBusEvents>;
  peerUrls: string[];
  instanceId: string;
}

export class FileInvalidationRelay {
  private unsub: (() => void) | null = null;

  constructor(private config: FileInvalidationRelayConfig) {}

  /** Start listening for file:hashChanged events and forwarding to peers. */
  start(): void {
    this.unsub = this.config.bus.on('file:hashChanged', (payload) => {
      void this.relayToAllPeers(payload);
    });
  }

  /** Stop listening. */
  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** Build ECP data part for file invalidation. */
  buildECPDataPart(filePath: string, newHash: string): ECPDataPart {
    return {
      ecp_version: 1,
      message_type: 'knowledge_transfer',
      epistemic_type: 'known',
      confidence: 1.0,
      confidence_reported: true,
      payload: {
        type: 'file_invalidation',
        filePath,
        newHash,
        instance_id: this.config.instanceId,
        timestamp: Date.now(),
      },
    };
  }

  private async relayToAllPeers(payload: { filePath: string; newHash: string }): Promise<void> {
    const ecpPart = this.buildECPDataPart(payload.filePath, payload.newHash);
    const a2aPart = wrapAsA2ADataPart(ecpPart);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `file-inv-${Date.now()}`,
      method: 'tasks/send',
      params: {
        id: `file-inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        message: {
          role: 'agent',
          parts: [a2aPart],
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
          // Fire-and-forget — Tier 0 best-effort
        }
      }),
    );
  }
}
