/**
 * A2AManager — Coordinator that wires all A2A/ECP modules into the runtime.
 *
 * Instantiates sub-managers based on network config feature flags,
 * routes incoming ECP messages to the correct handler,
 * and manages start/stop lifecycle for long-running modules.
 *
 * Zero overhead when network.instances.enabled = false (default).
 *
 * ── Agent vocabulary ─────────────────────────────────────────────────
 * This module deals with **Agent type #5 — Peer Instance**: another
 * Vinyan installation participating in the A2A network. Trust tier:
 * `earned` via `PeerTrustLevel` (`untrusted | probation | trusted`),
 * promoted/demoted by Wilson-LB on verification accuracy.
 *
 * Identifier is `instanceId` (not `agentId`). NOT to be confused with #1
 * Persona, #2 Worker, or #3 CLI Delegate. Full taxonomy in
 * `docs/foundation/agent-vocabulary.md`. Branded ID type for new code:
 * `PeerInstanceId` from `src/core/agent-vocabulary.ts`.
 *
 * Note: `src/db/agent-profile-store.ts` is a *different* concept again —
 * it stores the workspace-level singleton "who is this Vinyan installation"
 * record. That name is legacy and slated for rename to `InstanceProfile`.
 */
import { basename, join } from 'node:path';

import type { VinyanConfig } from '../config/schema.ts';
import { resolveInstanceId } from './identity.ts';
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import { CalibrationExchange } from './calibration.ts';
import type { CapabilityUpdate } from './capability-updates.ts';
import { CapabilityManager } from './capability-updates.ts';
import { CommitmentTracker } from './commitment.ts';
import { CostTracker } from './cost-signal.ts';
import type { ECPDataPart } from './ecp-data-part.ts';
import { type ECPFeedback, FeedbackManager } from './feedback.ts';
import { FileInvalidationRelay } from './file-invalidation-relay.ts';
import { GossipManager } from './gossip.ts';
import { type ECPIntent, IntentManager } from './intent.ts';
import { KnowledgeExchangeManager } from './knowledge-exchange.ts';
import { type ECPAffirm, type ECPProposal, NegotiationManager } from './negotiation.ts';
import { PeerHealthMonitor } from './peer-health.ts';
import { PeerTrustManager } from './peer-trust.ts';
import { RemoteBusAdapter } from './remote-bus.ts';
import { type ECPRetraction, RetractionManager } from './retraction.ts';
import { type ECPRoomUpdate, RoomManager } from './room.ts';
import { DistributedTracer } from './trace-context.ts';
import { type TrustAttestation, TrustAttestationManager } from './trust-attestation.ts';

// ── Types ─────────────────────────────────────────────────────────────

export interface A2AManagerConfig {
  workspace: string;
  bus: EventBus<VinyanBusEvents>;
  network: NonNullable<VinyanConfig['network']>;
}

export interface ECPRoutingResult {
  handled: boolean;
  type?: string;
  data?: Record<string, unknown>;
}

export interface A2AManagerIdentity {
  instanceId: string;
  publicKey: string;
}

// ── Factory ───────────────────────────────────────────────────────────

export function createA2AManager(config: A2AManagerConfig): A2AManagerImpl {
  return new A2AManagerImpl(config);
}

// ── Implementation ────────────────────────────────────────────────────

export class A2AManagerImpl {
  readonly identity: A2AManagerIdentity;

  // Group 1 — always created
  readonly peerTrustManager: PeerTrustManager;
  readonly costTracker: CostTracker;
  readonly retractionManager: RetractionManager;

  // Group 2 — if instances.enabled
  readonly peerHealthMonitor: PeerHealthMonitor | undefined;
  readonly remoteBusAdapter: RemoteBusAdapter | undefined;
  readonly capabilityManager: CapabilityManager | undefined;
  readonly calibrationExchange: CalibrationExchange | undefined;

  // Group 3 — feature-flagged
  readonly fileInvalidationRelay: FileInvalidationRelay | undefined;
  readonly knowledgeExchangeManager: KnowledgeExchangeManager | undefined;
  readonly gossipManager: GossipManager | undefined;
  readonly feedbackManager: FeedbackManager | undefined;
  readonly trustAttestationManager: TrustAttestationManager | undefined;
  readonly negotiationManager: NegotiationManager | undefined;
  readonly commitmentTracker: CommitmentTracker | undefined;
  readonly intentManager: IntentManager | undefined;
  readonly distributedTracer: DistributedTracer | undefined;
  readonly roomManager: RoomManager | undefined;

  private intervals = new Set<ReturnType<typeof setInterval>>();
  private started = false;

  constructor(private config: A2AManagerConfig) {
    const { bus, network, workspace } = config;
    const instanceId = resolveInstanceId(workspace);
    this.identity = { instanceId, publicKey: '' };

    const instances = network.instances;
    const trust = network.trust;
    const ks = network.knowledge_sharing;
    const coord = network.coordination;
    const tracing = network.tracing;

    // Derive peer URLs
    const peers = instances?.peers ?? [];
    const a2aEndpoints = peers.map((p) => `${p.url}/a2a`);

    // ── Group 1: Always created ──────────────────────────────────────

    this.peerTrustManager = new PeerTrustManager({
      promotionMinInteractions: trust?.promotion_min_interactions,
      untrustedPromotionLB: trust?.promotion_untrusted_lb,
      provisionalPromotionLB: trust?.promotion_provisional_lb,
      establishedPromotionLB: trust?.promotion_established_lb,
      demotionConsecutiveFailures: trust?.demotion_on_consecutive_failures,
      inactivityDecayMs: trust?.inactivity_decay_days ? trust.inactivity_decay_days * 86_400_000 : undefined,
    });

    this.costTracker = new CostTracker();

    this.retractionManager = new RetractionManager({
      instanceId,
      bus,
      trustManager: this.peerTrustManager,
    });

    // ── Group 2: If instances.enabled ────────────────────────────────

    if (instances?.enabled && peers.length > 0) {
      // Register peers in trust manager
      for (const peer of peers) {
        this.peerTrustManager.registerPeer(peer.url, peer.url);
      }

      this.peerHealthMonitor = new PeerHealthMonitor(
        {
          heartbeatIntervalMs: instances.heartbeat_interval_ms ?? 15_000,
          heartbeatTimeoutMs: instances.heartbeat_timeout_ms ?? 45_000,
          instanceId,
        },
        bus,
      );

      for (const peer of peers) {
        this.peerHealthMonitor.addPeer(peer.url, `${peer.url}/a2a`);
      }

      this.remoteBusAdapter = new RemoteBusAdapter({
        bus,
        peerUrls: a2aEndpoints,
        instanceId,
      });

      this.capabilityManager = new CapabilityManager({
        instanceId,
        peerUrls: a2aEndpoints,
        bus,
      });

      this.calibrationExchange = new CalibrationExchange({ instanceId });
    }

    // ── Group 3: Feature-flagged ─────────────────────────────────────

    if (ks?.enabled && ks.file_invalidation_enabled && a2aEndpoints.length > 0) {
      this.fileInvalidationRelay = new FileInvalidationRelay({
        bus,
        peerUrls: a2aEndpoints,
        instanceId,
      });
    }

    if (ks?.enabled && ks.batch_exchange_enabled) {
      this.knowledgeExchangeManager = new KnowledgeExchangeManager({
        bus,
        projectId: basename(workspace),
        instanceId,
        targetMarkers: { frameworks: [], languages: ['typescript'] },
      });
    }

    if (ks?.enabled && ks.gossip_enabled && a2aEndpoints.length > 0) {
      this.gossipManager = new GossipManager({
        instanceId,
        peerUrls: a2aEndpoints,
        fanout: ks.gossip_fanout,
        maxHops: ks.gossip_max_hops,
        dampeningWindowMs: ks.gossip_dampening_window_ms,
        bus,
        trustManager: this.peerTrustManager,
        getPeerHealth: (peerId) => this.peerHealthMonitor?.getState(peerId) ?? 'partitioned',
      });
    }

    if (ks?.enabled) {
      this.feedbackManager = new FeedbackManager({
        instanceId,
        bus,
        trustManager: this.peerTrustManager,
      });
    }

    if (trust?.trust_sharing_enabled) {
      this.trustAttestationManager = new TrustAttestationManager({
        instanceId,
        trustManager: this.peerTrustManager,
        maxRemoteTrust: trust.max_remote_trust,
        minInteractionsToAttest: trust.attestation_min_interactions,
        maxAttestersPerSubject: trust.attestation_max_attesters,
      });
    }

    if (coord?.negotiation_enabled) {
      this.negotiationManager = new NegotiationManager({
        instanceId,
        bus,
      });
    }

    if (coord?.commitment_tracking_enabled) {
      this.commitmentTracker = new CommitmentTracker({
        instanceId,
        bus,
        trustManager: this.peerTrustManager,
      });
    }

    if (coord?.intent_declaration_enabled) {
      this.intentManager = new IntentManager({ instanceId, bus });
    }

    if (tracing?.distributed_enabled) {
      this.distributedTracer = new DistributedTracer({ instanceId });
    }

    if (coord?.rooms_enabled && instances?.enabled) {
      this.roomManager = new RoomManager({
        instanceId,
        bus,
        maxRooms: coord.max_rooms,
        maxMessageHistory: coord.max_message_history,
      });
      if (this.remoteBusAdapter) {
        this.remoteBusAdapter.setRoomManager(this.roomManager);
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Start modules with active timers/listeners
    this.peerHealthMonitor?.start();
    this.remoteBusAdapter?.start();
    this.fileInvalidationRelay?.start();
    this.knowledgeExchangeManager?.start();

    // Periodic maintenance intervals
    if (this.commitmentTracker) {
      this.addInterval(() => this.commitmentTracker?.checkDeadlines(), 30_000);
    }
    if (this.negotiationManager) {
      this.addInterval(() => this.negotiationManager?.cleanExpired(), 30_000);
    }
    if (this.intentManager) {
      this.addInterval(() => this.intentManager?.cleanExpiredLeases(), 60_000);
    }
    if (this.gossipManager) {
      const window = this.config.network.knowledge_sharing?.gossip_dampening_window_ms ?? 10_000;
      this.addInterval(() => this.gossipManager?.cleanExpired(), window);
    }
    this.addInterval(() => this.retractionManager.cleanExpired(), 300_000);
    this.addInterval(() => this.peerTrustManager.applyInactivityDecay(), 3_600_000);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Clear all periodic intervals
    for (const id of this.intervals) {
      clearInterval(id);
    }
    this.intervals.clear();

    // Stop modules in reverse order
    this.knowledgeExchangeManager?.stop();
    this.fileInvalidationRelay?.stop();
    this.remoteBusAdapter?.stop();
    this.peerHealthMonitor?.stop();
  }

  // ── ECP Message Routing ─────────────────────────────────────────────

  routeECPMessage(peerId: string, ecpPart: ECPDataPart): ECPRoutingResult {
    const payload = ecpPart.payload as Record<string, unknown>;

    switch (ecpPart.message_type) {
      // ── Heartbeat ──
      case 'heartbeat':
        return { handled: true, type: 'heartbeat_ack' };

      // ── Negotiation ──
      case 'propose':
        this.negotiationManager?.handleIncomingProposal(peerId, payload as unknown as ECPProposal);
        return { handled: true, type: 'proposal_received' };

      case 'affirm':
        this.negotiationManager?.handleIncomingAffirm(peerId, payload as unknown as ECPAffirm);
        return { handled: true, type: 'affirm_received' };

      // ── Commitment ──
      case 'commit':
        return { handled: true, type: 'commitment_received' };

      // ── Retraction ──
      case 'retract':
        this.retractionManager.handleRetraction(peerId, payload as unknown as ECPRetraction);
        return { handled: true, type: 'retraction_received' };

      // ── Feedback ──
      case 'feedback':
        this.feedbackManager?.handleFeedback(peerId, payload as unknown as ECPFeedback);
        return { handled: true, type: 'feedback_received' };

      // ── Intent ──
      case 'intent_declare': {
        const ack = this.intentManager?.handleRemoteIntent(peerId, payload as unknown as ECPIntent);
        return { handled: true, type: 'intent_ack', data: ack ? { ack } : undefined };
      }

      case 'intent_release':
        this.intentManager?.release(payload.intent_id as string);
        return { handled: true, type: 'intent_released' };

      // ── Knowledge ──
      case 'knowledge_transfer':
        return this.routeKnowledgeTransfer(peerId, payload);

      case 'knowledge_offer':
        if (this.knowledgeExchangeManager) {
          const offer = payload as unknown as import('./knowledge-exchange.ts').KnowledgeOffer;
          const acceptance = this.knowledgeExchangeManager.evaluateOffer(offer);
          this.config.bus.emit('a2a:knowledgeOffered', {
            peerId,
            patternCount: offer.patterns.length,
          });
          return {
            handled: true,
            type: 'knowledge_offer_evaluated',
            data: acceptance as unknown as Record<string, unknown>,
          };
        }
        return { handled: true, type: 'knowledge_offer_received' };

      case 'knowledge_accept':
        return { handled: true, type: 'knowledge_accept_received' };

      // ── Capability ──
      case 'capability_update':
        this.capabilityManager?.handleUpdate(peerId, payload as unknown as CapabilityUpdate);
        return { handled: true, type: 'capability_updated' };

      // ── Trust ──
      case 'trust_attestation': {
        const peerTrust = this.peerTrustManager.getTrustLevel(peerId);
        this.trustAttestationManager?.integrateAttestation(payload as unknown as TrustAttestation, peerTrust);
        return { handled: true, type: 'attestation_integrated' };
      }

      // ── Streaming ──
      case 'progress':
      case 'partial_verdict':
        return { handled: true, type: 'streaming_event' };

      // ── Cross-instance rooms (R3) ──
      case 'room_update':
        if (this.roomManager) {
          this.roomManager.handleRemoteRoomUpdate(peerId, payload as unknown as ECPRoomUpdate);
        }
        // Record room-scoped messages for observability
        if (ecpPart.room_id && this.roomManager) {
          this.roomManager.recordMessage(
            ecpPart.room_id,
            peerId,
            ecpPart.message_type,
            typeof payload.action === 'string' ? `${payload.action}` : 'room_update',
          );
        }
        return { handled: true, type: 'room_update_received' };

      // ── Task execution (fall through to bridge) ──
      default:
        // Record room-scoped non-room_update messages (any ECP type can be room-scoped via room_id)
        if (ecpPart.room_id && this.roomManager) {
          this.roomManager.recordMessage(
            ecpPart.room_id,
            peerId,
            ecpPart.message_type,
            `${ecpPart.message_type} from ${peerId}`,
          );
        }
        return { handled: false };
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  private routeKnowledgeTransfer(peerId: string, payload: Record<string, unknown>): ECPRoutingResult {
    // Gossip envelope: has knowledge_id field
    if (payload.knowledge_id && this.gossipManager) {
      this.gossipManager.propagate(payload as any, peerId);
      return { handled: true, type: 'gossip_propagated' };
    }

    // Knowledge transfer with patterns — import via KnowledgeExchangeManager
    if (this.knowledgeExchangeManager && payload.patterns) {
      const transfer = payload as unknown as import('./knowledge-exchange.ts').KnowledgeTransfer;
      const imported = this.knowledgeExchangeManager.importPatterns(transfer, peerId);
      return { handled: true, type: 'knowledge_transfer_imported', data: { imported: imported.length } };
    }

    return { handled: true, type: 'knowledge_transfer_received' };
  }

  private addInterval(fn: () => void, ms: number): void {
    const timer = setInterval(fn, ms);
    // Defensive unref — if stop() is skipped, background A2A housekeeping
    // should not keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    this.intervals.add(timer);
  }
}

// resolveInstanceId moved to ./identity.ts — shared by A2AManager and factory.ts
