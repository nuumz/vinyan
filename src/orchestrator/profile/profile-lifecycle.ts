/**
 * ProfileLifecycle — generic FSM for any profile kind.
 *
 * States: probation → active → demoted → retired.
 *
 * Invariants:
 *  - I8: never demote the last active profile (emergency reactivation is the
 *    only way back once everyone is down).
 *  - demotionCount cap: after maxDemotions demotions, profile permanently retires.
 *  - Re-enrollment cooldown: demoted profiles wait `reentryCooldownMs` before
 *    being moved back to probation.
 *
 * Gate decisions live in LifecycleGates<T> implementations — this class only
 * runs the state machine, emits events, and enforces invariants.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { AgentProfileBase, AgentProfileKind, ProfileStore } from './agent-profile.ts';

export interface PromotionVerdict {
  promote: boolean;
  reason: string;
}

export interface DemotionVerdict {
  demote: boolean;
  reason: string;
}

export interface LifecycleGates<T extends AgentProfileBase> {
  /** Decide whether a probation profile earned active status. */
  shouldPromote(profile: T, fleet: readonly T[]): PromotionVerdict;
  /** Decide whether an active profile should be demoted. */
  shouldDemote(profile: T, fleet: readonly T[]): DemotionVerdict;
}

export interface ProfileLifecycleConfig<T extends AgentProfileBase> {
  kind: AgentProfileKind;
  store: ProfileStore<T>;
  gates: LifecycleGates<T>;
  bus?: VinyanBus;
  /** Permanent retirement after this many demotions. Default 3. */
  maxDemotions?: number;
  /** Milliseconds a demoted profile must wait before re-enrollment check. Default 0 (eager). */
  reentryCooldownMs?: number;
}

export interface LifecycleTransition {
  id: string;
  from: AgentProfileBase['status'];
  to: AgentProfileBase['status'];
  reason: string;
  permanent?: boolean;
}

export class ProfileLifecycle<T extends AgentProfileBase> {
  private readonly store: ProfileStore<T>;
  private readonly gates: LifecycleGates<T>;
  private readonly bus?: VinyanBus;
  private readonly kind: AgentProfileKind;
  private readonly maxDemotions: number;
  private readonly reentryCooldownMs: number;

  constructor(config: ProfileLifecycleConfig<T>) {
    this.store = config.store;
    this.gates = config.gates;
    this.bus = config.bus;
    this.kind = config.kind;
    this.maxDemotions = config.maxDemotions ?? 3;
    this.reentryCooldownMs = config.reentryCooldownMs ?? 0;
  }

  /** Evaluate a single probation profile and promote if gates pass. */
  evaluatePromotion(id: string): PromotionVerdict {
    const profile = this.store.findById(id);
    if (!profile) return { promote: false, reason: 'not found' };
    if (profile.status !== 'probation') {
      return { promote: false, reason: `not on probation (${profile.status})` };
    }
    const active = this.store.findActive();
    const verdict = this.gates.shouldPromote(profile, active);
    if (!verdict.promote) return verdict;

    this.store.updateStatus(id, 'active');
    this.bus?.emit('profile:promoted', { kind: this.kind, id, reason: verdict.reason });
    return verdict;
  }

  /** Walk active profiles and demote the ones whose gates trip. */
  checkDemotions(): LifecycleTransition[] {
    const active = this.store.findActive();
    const transitions: LifecycleTransition[] = [];

    // I8: keep at least one active profile alive. Track the running total so
    // mass-demotion in the same sweep never drains the fleet.
    let remainingActive = active.length;

    for (const profile of active) {
      if (remainingActive <= 1) break; // I8 floor

      const verdict = this.gates.shouldDemote(profile, active);
      if (!verdict.demote) continue;

      const nextCount = profile.demotionCount + 1;
      const permanent = nextCount >= this.maxDemotions;
      const nextStatus: AgentProfileBase['status'] = permanent ? 'retired' : 'demoted';

      this.store.updateStatus(profile.id, nextStatus, verdict.reason);
      remainingActive -= 1;

      this.bus?.emit('profile:demoted', {
        kind: this.kind,
        id: profile.id,
        reason: verdict.reason,
        permanent,
      });

      transitions.push({
        id: profile.id,
        from: 'active',
        to: nextStatus,
        reason: verdict.reason,
        permanent,
      });
    }

    return transitions;
  }

  /**
   * Re-enroll demoted profiles whose cooldown has elapsed. Called during
   * sleep cycle. Uses wall-clock cooldown (reentryCooldownMs). Concrete
   * gate implementations can layer trace-count cooldowns on top by
   * inspecting profile.demotedAt.
   */
  reEnrollExpired(now: number = Date.now()): string[] {
    if (!this.store.reEnroll) return [];
    const demoted = this.store.findByStatus('demoted');
    const reEnrolled: string[] = [];

    for (const profile of demoted) {
      if (profile.demotionCount >= this.maxDemotions) {
        this.store.updateStatus(profile.id, 'retired', 'max demotions reached');
        this.bus?.emit('profile:retired', {
          kind: this.kind,
          id: profile.id,
          reason: 'max demotions reached',
        });
        continue;
      }
      if (profile.demotedAt && now - profile.demotedAt < this.reentryCooldownMs) continue;

      this.store.reEnroll(profile.id);
      this.bus?.emit('profile:reactivated', { kind: this.kind, id: profile.id });
      reEnrolled.push(profile.id);
    }
    return reEnrolled;
  }

  /**
   * Emergency reactivation — if the fleet has zero active profiles, promote
   * the best demoted one so the system can keep serving. Returns the id of
   * the reactivated profile, or null if nothing could be recovered.
   */
  emergencyReactivation(
    pickBest: (candidates: T[]) => T | null = (c) => c[0] ?? null,
  ): string | null {
    if (this.store.findActive().length > 0) return null;
    const demoted = this.store.findByStatus('demoted');
    if (demoted.length === 0) return null;
    const chosen = pickBest(demoted);
    if (!chosen) return null;
    this.store.updateStatus(chosen.id, 'active');
    this.bus?.emit('profile:reactivated', {
      kind: this.kind,
      id: chosen.id,
      emergency: true,
    });
    return chosen.id;
  }
}
