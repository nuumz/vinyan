/**
 * LocalOracleGates — A7 learning loop for in-process oracles.
 *
 * Evidence source: OracleAccuracyStore.computeOracleAccuracy() (retrospective
 * accuracy from post-hoc outcome resolution, bootstrap-protected at 10+
 * resolved verdicts).
 *
 * Gates:
 *   - Promotion (probation → active): accuracy ≥ promotionMinAccuracy after
 *     probationMinResolved resolved verdicts.
 *   - Demotion (active → demoted): accuracy < demotionAccuracyFloor after
 *     demotionMinResolved resolved verdicts.
 *
 * Profiles for local oracles live in LocalOracleProfileStore (added in Step 2).
 * This module is the decision logic only; ProfileLifecycle drives the FSM.
 */

import type { OracleAccuracyStore } from '../../db/oracle-accuracy-store.ts';
import type { AgentProfileBase } from './agent-profile.ts';
import type { DemotionVerdict, LifecycleGates, PromotionVerdict } from './profile-lifecycle.ts';

export interface LocalOracleProfile extends AgentProfileBase {
  /** The oracle name as used by OracleAccuracyStore (stable key). */
  oracleName: string;
}

export interface LocalOracleGatesConfig {
  accuracyStore: OracleAccuracyStore;
  /** Minimum resolved verdicts before promotion is allowed. Default 20. */
  probationMinResolved?: number;
  /** Minimum accuracy for promotion. Default 0.8. */
  promotionMinAccuracy?: number;
  /** Minimum resolved verdicts before demotion is allowed. Default 20. */
  demotionMinResolved?: number;
  /** Demote when accuracy falls below this floor. Default 0.6. */
  demotionAccuracyFloor?: number;
  /** Lookback window in days — passed through to computeOracleAccuracy. */
  windowDays?: number;
}

export class LocalOracleGates implements LifecycleGates<LocalOracleProfile> {
  private readonly accuracyStore: OracleAccuracyStore;
  private readonly probationMinResolved: number;
  private readonly promotionMinAccuracy: number;
  private readonly demotionMinResolved: number;
  private readonly demotionAccuracyFloor: number;
  private readonly windowDays?: number;

  constructor(config: LocalOracleGatesConfig) {
    this.accuracyStore = config.accuracyStore;
    this.probationMinResolved = config.probationMinResolved ?? 20;
    this.promotionMinAccuracy = config.promotionMinAccuracy ?? 0.8;
    this.demotionMinResolved = config.demotionMinResolved ?? 20;
    this.demotionAccuracyFloor = config.demotionAccuracyFloor ?? 0.6;
    this.windowDays = config.windowDays;
  }

  shouldPromote(profile: LocalOracleProfile): PromotionVerdict {
    const stats = this.accuracyStore.computeOracleAccuracy(profile.oracleName, this.windowDays);
    const resolved = stats.correct + stats.wrong;
    if (resolved < this.probationMinResolved) {
      return {
        promote: false,
        reason: `insufficient resolved verdicts: ${resolved}/${this.probationMinResolved}`,
      };
    }
    if (stats.accuracy == null) {
      return { promote: false, reason: 'accuracy not yet bootstrapped' };
    }
    if (stats.accuracy < this.promotionMinAccuracy) {
      return {
        promote: false,
        reason: `accuracy ${stats.accuracy.toFixed(3)} < ${this.promotionMinAccuracy.toFixed(2)}`,
      };
    }
    return { promote: true, reason: `accuracy ${stats.accuracy.toFixed(3)} meets bar` };
  }

  shouldDemote(profile: LocalOracleProfile): DemotionVerdict {
    const stats = this.accuracyStore.computeOracleAccuracy(profile.oracleName, this.windowDays);
    const resolved = stats.correct + stats.wrong;
    if (resolved < this.demotionMinResolved) {
      return { demote: false, reason: 'insufficient evidence to demote' };
    }
    if (stats.accuracy == null) {
      return { demote: false, reason: 'accuracy not yet bootstrapped' };
    }
    if (stats.accuracy < this.demotionAccuracyFloor) {
      return {
        demote: true,
        reason: `accuracy ${stats.accuracy.toFixed(3)} < floor ${this.demotionAccuracyFloor.toFixed(2)}`,
      };
    }
    return { demote: false, reason: 'within bounds' };
  }
}
