/**
 * Dynamic Capability Updates — push/pull oracle capability changes to peers.
 *
 * Structural changes (oracle added/removed) are sent immediately.
 * Metric drift (accuracy changes) is batched every 60s.
 * Staleness: capability_version is monotonic — receiver rejects older versions.
 *
 * Source of truth: Plan Phase J1
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import { ECP_MIME_TYPE } from './ecp-data-part.ts';

export type CapabilityUpdateType = 'oracle_added' | 'oracle_removed' | 'oracle_metrics' | 'full_snapshot';

export interface CapabilityDelta {
  oracle_name: string;
  action: 'added' | 'removed' | 'updated';
  details?: Record<string, unknown>;
}

export interface CapabilityUpdate {
  instance_id: string;
  capability_version: number;
  update_type: CapabilityUpdateType;
  delta?: CapabilityDelta;
  snapshot?: Record<string, unknown>;
  timestamp: number;
}

interface RemoteCapabilityRecord {
  instanceId: string;
  peerId: string;
  capabilityVersion: number;
  lastUpdate: number;
  snapshot?: Record<string, unknown>;
}

export interface CapabilityManagerConfig {
  instanceId: string;
  peerUrls: string[];
  bus?: EventBus<VinyanBusEvents>;
  /** Optional oracle profile store for creating probation profiles from peer capability updates (PH5.9). */
  oracleProfileStore?: import('../db/oracle-profile-store.ts').OracleProfileStore;
}

export class CapabilityManager {
  private currentVersion = 0;
  private remoteCapabilities = new Map<string, RemoteCapabilityRecord>();

  constructor(private config: CapabilityManagerConfig) {}

  broadcastUpdate(
    updateType: CapabilityUpdateType,
    delta?: CapabilityDelta,
    snapshot?: Record<string, unknown>,
  ): CapabilityUpdate {
    this.currentVersion++;

    const update: CapabilityUpdate = {
      instance_id: this.config.instanceId,
      capability_version: this.currentVersion,
      update_type: updateType,
      delta,
      snapshot,
      timestamp: Date.now(),
    };

    // Fire-and-forget to all peers
    void this.sendToPeers(update);
    return update;
  }

  handleUpdate(peerId: string, update: CapabilityUpdate): boolean {
    const existing = this.remoteCapabilities.get(peerId);

    // Reject stale versions
    if (existing && update.capability_version <= existing.capabilityVersion) {
      return false;
    }

    this.remoteCapabilities.set(peerId, {
      instanceId: update.instance_id,
      peerId,
      capabilityVersion: update.capability_version,
      lastUpdate: update.timestamp,
      snapshot: update.snapshot ?? existing?.snapshot,
    });

    this.config.bus?.emit('a2a:capabilityUpdated', {
      peerId,
      instanceId: update.instance_id,
      capabilityVersion: update.capability_version,
    });

    // PH5.9: Create oracle profile in probation when a peer adds an oracle
    if (update.update_type === 'oracle_added' && update.delta && this.config.oracleProfileStore) {
      const existing = this.config.oracleProfileStore.getProfile(update.instance_id, update.delta.oracle_name);
      if (!existing) {
        this.config.oracleProfileStore.createProfile({
          instanceId: update.instance_id,
          oracleName: update.delta.oracle_name,
        });
      }
    }

    return true;
  }

  getRemoteCapabilities(): RemoteCapabilityRecord[] {
    return [...this.remoteCapabilities.values()];
  }

  getRemoteCapability(peerId: string): RemoteCapabilityRecord | undefined {
    return this.remoteCapabilities.get(peerId);
  }

  getCurrentVersion(): number {
    return this.currentVersion;
  }

  private async sendToPeers(update: CapabilityUpdate): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      method: 'tasks/send',
      params: {
        id: `cap-${Date.now()}`,
        message: {
          role: 'agent',
          parts: [
            {
              type: 'data',
              mimeType: ECP_MIME_TYPE,
              data: {
                ecp_version: 1,
                message_type: 'capability_update',
                epistemic_type: 'known',
                confidence: 1.0,
                confidence_reported: true,
                payload: update,
              },
            },
          ],
        },
      },
    });

    await Promise.allSettled(
      this.config.peerUrls.map(async (url) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          await fetch(url, {
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
