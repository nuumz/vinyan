/**
 * Peer Health Monitor — heartbeat-based partition detection.
 *
 * State machine: connected →(miss)→ degraded →(3 misses)→ partitioned
 * Recovery: successful heartbeat → connected (from any state).
 * Heartbeat via A2A tasks/send with ECP message_type: "heartbeat".
 *
 * Source of truth: Plan Phase L1
 */
import type { EventBus, VinyanBusEvents } from "../core/bus.ts";
import { ECP_MIME_TYPE } from "./ecp-data-part.ts";

// ── Types ─────────────────────────────────────────────────────────────

export type PeerHealthState = "connected" | "degraded" | "partitioned";

export interface PeerHealthRecord {
  peerId: string;
  url: string;
  state: PeerHealthState;
  lastHeartbeatAt: number;
  consecutiveMisses: number;
  latency_ms: number;
}

export interface PeerHealthConfig {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  degradedAfterMisses?: number;
  partitionedAfterMisses?: number;
  instanceId: string;
}

// ── Monitor ───────────────────────────────────────────────────────────

export class PeerHealthMonitor {
  private peers = new Map<string, PeerHealthRecord>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly degradedAfterMisses: number;
  private readonly partitionedAfterMisses: number;

  constructor(
    private config: PeerHealthConfig,
    private bus?: EventBus<VinyanBusEvents>,
  ) {
    this.degradedAfterMisses = config.degradedAfterMisses ?? 1;
    this.partitionedAfterMisses = config.partitionedAfterMisses ?? 3;
  }

  /** Add a peer to monitor. Initial state is connected. */
  addPeer(peerId: string, url: string): void {
    this.peers.set(peerId, {
      peerId,
      url,
      state: "connected",
      lastHeartbeatAt: Date.now(),
      consecutiveMisses: 0,
      latency_ms: 0,
    });
  }

  /** Remove a peer from monitoring. */
  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  /** Start periodic heartbeat cycle. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.runHeartbeatCycle();
    }, this.config.heartbeatIntervalMs);
  }

  /** Stop periodic heartbeat. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Get health state for a peer. */
  getState(peerId: string): PeerHealthState {
    return this.peers.get(peerId)?.state ?? "partitioned";
  }

  /** Get all peer health records. */
  getAllStates(): PeerHealthRecord[] {
    return [...this.peers.values()];
  }

  /** Run one heartbeat cycle — send heartbeat to all peers and update states. */
  async runHeartbeatCycle(): Promise<void> {
    const promises = [...this.peers.values()].map(async (record) => {
      const success = await this.sendHeartbeat(record);
      this.updateState(record, success);
    });
    await Promise.allSettled(promises);
  }

  // ── Private ────────────────────────────────────────────────────────

  private async sendHeartbeat(record: PeerHealthRecord): Promise<boolean> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.heartbeatTimeoutMs);

    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: `hb-${Date.now()}`,
        method: "tasks/send",
        params: {
          id: `hb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          message: {
            role: "agent",
            parts: [{
              type: "data",
              mimeType: ECP_MIME_TYPE,
              data: {
                ecp_version: 1,
                message_type: "heartbeat",
                epistemic_type: "known",
                confidence: 1.0,
                confidence_reported: true,
                payload: {
                  instance_id: this.config.instanceId,
                  timestamp: Date.now(),
                },
              },
            }],
          },
        },
      });

      const response = await fetch(record.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      record.latency_ms = Date.now() - start;
      return response.ok;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  private updateState(record: PeerHealthRecord, heartbeatSuccess: boolean): void {
    const previousState = record.state;

    if (heartbeatSuccess) {
      record.consecutiveMisses = 0;
      record.lastHeartbeatAt = Date.now();
      record.state = "connected";

      if (previousState !== "connected") {
        this.bus?.emit("peer:connected", {
          peerId: record.peerId,
          instanceId: this.config.instanceId,
          url: record.url,
        });
      }
    } else {
      record.consecutiveMisses++;

      if (record.consecutiveMisses >= this.partitionedAfterMisses) {
        record.state = "partitioned";
      } else if (record.consecutiveMisses >= this.degradedAfterMisses) {
        record.state = "degraded";
      }

      if (record.state === "partitioned" && previousState !== "partitioned") {
        this.bus?.emit("peer:disconnected", {
          peerId: record.peerId,
          reason: `${record.consecutiveMisses} consecutive heartbeat failures`,
        });
      }
    }
  }
}
