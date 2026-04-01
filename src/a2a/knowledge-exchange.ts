/**
 * Knowledge Exchange Manager — Tier 2 batch sharing over Sleep Cycle.
 *
 * 3-phase protocol: offer → accept → transfer.
 * Subscribes to `sleep:cycleComplete` to initiate knowledge export.
 * Imported patterns enter probation with 50% confidence reduction.
 *
 * Source of truth: Plan Phase E2
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import {
  type AbstractPattern,
  abstractPattern,
  classifyPortability,
  importAbstractPattern,
  projectSimilarity,
} from '../evolution/pattern-abstraction.ts';
import type { ExtractedPattern, TaskFingerprint } from '../orchestrator/types.ts';

// ── Protocol types ────────────────────────────────────────────────────

export interface KnowledgeOffer {
  cycleId: string;
  instanceId: string;
  patterns: KnowledgeOfferItem[];
}

export interface KnowledgeOfferItem {
  id: string;
  type: string;
  fingerprint: TaskFingerprint;
  confidence: number;
  portability: 'universal' | 'framework-specific' | 'project-specific';
}

export interface KnowledgeAcceptance {
  acceptedPatternIds: string[];
  rejectedPatternIds: string[];
}

export interface KnowledgeTransfer {
  patterns: AbstractPattern[];
}

// ── Configuration ─────────────────────────────────────────────────────

export interface KnowledgeExchangeConfig {
  bus: EventBus<VinyanBusEvents>;
  projectId: string;
  instanceId: string;
  targetMarkers: { frameworks: string[]; languages: string[] };
  /** Minimum Jaccard similarity to accept a pattern (default: 0.5). */
  minSimilarity?: number;
}

// ── Manager ───────────────────────────────────────────────────────────

export class KnowledgeExchangeManager {
  private unsub: (() => void) | null = null;
  private readonly minSimilarity: number;

  constructor(private config: KnowledgeExchangeConfig) {
    this.minSimilarity = config.minSimilarity ?? 0.5;
  }

  /** Subscribe to sleep:cycleComplete events. */
  start(): void {
    this.unsub = this.config.bus.on('sleep:cycleComplete', (_payload) => {
      // In a full implementation, this would trigger export to peers.
      // The actual export logic is handled by the caller who has peer URLs.
    });
  }

  /** Unsubscribe from bus events. */
  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** Create an offer from extracted patterns for sharing with peers. */
  createOffer(patterns: ExtractedPattern[], cycleId: string): KnowledgeOffer {
    const items: KnowledgeOfferItem[] = [];

    for (const p of patterns) {
      const abstracted = abstractPattern(p, this.config.projectId);
      if (!abstracted) continue;

      items.push({
        id: p.id,
        type: p.type,
        fingerprint: abstracted.fingerprint,
        confidence: abstracted.confidence,
        portability: classifyPortability(abstracted),
      });
    }

    return {
      cycleId,
      instanceId: this.config.instanceId,
      patterns: items,
    };
  }

  /** Evaluate an incoming offer from a peer — accept or reject each pattern. */
  evaluateOffer(offer: KnowledgeOffer): KnowledgeAcceptance {
    const accepted: string[] = [];
    const rejected: string[] = [];

    for (const item of offer.patterns) {
      // Reject project-specific patterns (cannot transfer)
      if (item.portability === 'project-specific') {
        rejected.push(item.id);
        continue;
      }

      // Check similarity
      const conditions = {
        frameworkMarkers: item.fingerprint.frameworkMarkers ?? [],
        languageMarkers: item.fingerprint.fileExtensions ?? [],
        complexityRange: [item.fingerprint.blastRadiusBucket],
      };
      const similarity = projectSimilarity(conditions, this.config.targetMarkers);

      if (similarity >= this.minSimilarity) {
        accepted.push(item.id);
      } else {
        rejected.push(item.id);
      }
    }

    return { acceptedPatternIds: accepted, rejectedPatternIds: rejected };
  }

  /** Import accepted patterns with 50% confidence reduction (probation). */
  importPatterns(transfer: KnowledgeTransfer, peerId: string): ExtractedPattern[] {
    const imported: ExtractedPattern[] = [];

    for (const abstractPat of transfer.patterns) {
      const pattern = importAbstractPattern(abstractPat, this.config.projectId);
      imported.push(pattern);
    }

    if (imported.length > 0) {
      this.config.bus.emit('a2a:knowledgeImported', {
        peerId,
        patternsImported: imported.length,
        rulesImported: 0,
      });
    }

    return imported;
  }
}
