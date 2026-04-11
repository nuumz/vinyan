/**
 * Intent Declaration + Task Preemption — H1+H2.
 *
 * Conflict detection (3-tier):
 *   1. Direct file overlap (target ∩ target) → mandatory
 *   2. File vs blast radius (target ∈ other.blast_radius) → negotiate
 *   3. Blast vs blast overlap → advisory
 *
 * Resolution: priority-based → FCFS (earlier declared_at) → deterministic
 * tiebreak (lexicographic instance_id, A3).
 *
 * Lease auto-release on expiry via cleanExpiredLeases().
 *
 * Source of truth: Plan Phase H1+H2
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';

export type IntentAction = 'modify' | 'delete' | 'create' | 'refactor';
export type IntentPriority = 'critical' | 'high' | 'normal' | 'low';
export type IntentAck = 'proceed' | 'wait' | 'negotiate' | 'yield';
export type ConflictLevel = 'mandatory' | 'negotiate' | 'advisory';

export const DEFAULT_TTLS: Record<IntentPriority, number> = {
  critical: 600_000,
  high: 300_000,
  normal: 180_000,
  low: 60_000,
};

const PRIORITY_ORDER: Record<IntentPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export interface ECPIntent {
  intent_id: string;
  instance_id: string;
  action: IntentAction;
  targets: string[];
  blast_radius?: string[];
  priority: IntentPriority;
  lease_ttl_ms: number;
  description?: string;
  declared_at: number;
  expiresAt: number;
}

export interface ECPPreemption {
  preemption_id: string;
  target_task_id: string;
  reason: string;
  replacement_task_id?: string;
  priority: IntentPriority;
  grace_period_ms: number;
}

export interface ConflictResult {
  conflicting_intent_id: string;
  conflict_level: ConflictLevel;
  recommended_ack: IntentAck;
  overlap_files: string[];
}

export interface IntentManagerConfig {
  instanceId: string;
  bus?: EventBus<VinyanBusEvents>;
}

function genId(): string {
  return `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function intersect(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

export class IntentManager {
  private intents = new Map<string, ECPIntent>();

  constructor(private config: IntentManagerConfig) {}

  declare(
    action: IntentAction,
    targets: string[],
    priority: IntentPriority,
    options?: { blastRadius?: string[]; description?: string; ttlMs?: number },
  ): ECPIntent {
    const ttl = options?.ttlMs ?? DEFAULT_TTLS[priority];
    const now = Date.now();

    const intent: ECPIntent = {
      intent_id: genId(),
      instance_id: this.config.instanceId,
      action,
      targets,
      blast_radius: options?.blastRadius,
      priority,
      lease_ttl_ms: ttl,
      description: options?.description,
      declared_at: now,
      expiresAt: now + ttl,
    };

    this.intents.set(intent.intent_id, intent);
    return intent;
  }

  release(intentId: string): boolean {
    return this.intents.delete(intentId);
  }

  renew(intentId: string, additionalMs?: number): boolean {
    const intent = this.intents.get(intentId);
    if (!intent) return false;

    const extension = additionalMs ?? intent.lease_ttl_ms;
    intent.expiresAt = Date.now() + extension;
    return true;
  }

  handleRemoteIntent(peerId: string, intent: ECPIntent): IntentAck {
    this.intents.set(intent.intent_id, intent);

    this.config.bus?.emit('a2a:intentDeclared', {
      peerId,
      intentId: intent.intent_id,
      targets: intent.targets,
      action: intent.action,
    });

    // Check conflicts against our local intents
    const conflicts = this.checkConflict(intent);

    if (conflicts.length > 0) {
      for (const conflict of conflicts) {
        this.config.bus?.emit('a2a:intentConflict', {
          peerId,
          intentId: intent.intent_id,
          conflictingIntentId: conflict.conflicting_intent_id,
        });
      }

      // Return the highest-severity ack
      const hasMandatory = conflicts.some((c) => c.conflict_level === 'mandatory');
      if (hasMandatory) {
        const mandatoryConflict = conflicts.find((c) => c.conflict_level === 'mandatory')!;
        return mandatoryConflict.recommended_ack;
      }
      const hasNegotiate = conflicts.some((c) => c.conflict_level === 'negotiate');
      if (hasNegotiate) return 'negotiate';
    }

    return 'proceed';
  }

  checkConflict(newIntent: ECPIntent): ConflictResult[] {
    const results: ConflictResult[] = [];

    for (const [, existing] of this.intents) {
      if (existing.intent_id === newIntent.intent_id) continue;
      if (existing.instance_id === newIntent.instance_id) continue;

      // Level 1: Direct file overlap (target ∩ target)
      const directOverlap = intersect(newIntent.targets, existing.targets);
      if (directOverlap.length > 0) {
        results.push({
          conflicting_intent_id: existing.intent_id,
          conflict_level: 'mandatory',
          recommended_ack: this.resolveAck(newIntent, existing),
          overlap_files: directOverlap,
        });
        continue;
      }

      // Level 2: File vs blast radius
      const newInExistingBlast = existing.blast_radius ? intersect(newIntent.targets, existing.blast_radius) : [];
      const existingInNewBlast = newIntent.blast_radius ? intersect(existing.targets, newIntent.blast_radius) : [];
      const fileBlastOverlap = [...new Set([...newInExistingBlast, ...existingInNewBlast])];

      if (fileBlastOverlap.length > 0) {
        results.push({
          conflicting_intent_id: existing.intent_id,
          conflict_level: 'negotiate',
          recommended_ack: 'negotiate',
          overlap_files: fileBlastOverlap,
        });
        continue;
      }

      // Level 3: Blast vs blast overlap
      if (newIntent.blast_radius && existing.blast_radius) {
        const blastOverlap = intersect(newIntent.blast_radius, existing.blast_radius);
        if (blastOverlap.length > 0) {
          results.push({
            conflicting_intent_id: existing.intent_id,
            conflict_level: 'advisory',
            recommended_ack: 'proceed',
            overlap_files: blastOverlap,
          });
        }
      }
    }

    return results;
  }

  getActiveIntents(): ECPIntent[] {
    return [...this.intents.values()];
  }

  getIntent(intentId: string): ECPIntent | undefined {
    return this.intents.get(intentId);
  }

  cleanExpiredLeases(): string[] {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, intent] of this.intents) {
      if (intent.expiresAt < now) {
        this.intents.delete(id);
        expired.push(id);
      }
    }

    return expired;
  }

  private resolveAck(incoming: ECPIntent, existing: ECPIntent): IntentAck {
    const incomingPriority = PRIORITY_ORDER[incoming.priority];
    const existingPriority = PRIORITY_ORDER[existing.priority];

    // Higher priority wins
    if (incomingPriority > existingPriority) return 'proceed';
    if (incomingPriority < existingPriority) return 'yield';

    // Same priority: FCFS
    if (incoming.declared_at > existing.declared_at) return 'yield';
    if (incoming.declared_at < existing.declared_at) return 'proceed';

    // Same timestamp: deterministic tiebreak on instance_id
    return incoming.instance_id < existing.instance_id ? 'proceed' : 'yield';
  }
}
