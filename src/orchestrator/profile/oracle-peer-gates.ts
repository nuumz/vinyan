/**
 * OraclePeerGates — promotion & demotion gate logic for remote oracle peers.
 *
 * Ported from src/orchestrator/instance-coordinator.ts:350-385.
 * Adds the promotion gate and emergency reactivation hook that the original
 * ad-hoc demote-only logic lacked.
 *
 * Evidence per profile (OracleProfile):
 *   verdictsRequested, verdictsAccurate, falsePositiveCount, timeoutCount
 */

import type { OracleProfileStore } from '../../db/oracle-profile-store.ts';
import type { OracleProfile } from '../instance-coordinator.ts';
import type { AgentProfileBase, AgentProfileStatus, ProfileStore } from './agent-profile.ts';
import type { DemotionVerdict, LifecycleGates, PromotionVerdict } from './profile-lifecycle.ts';

export interface OraclePeerGatesConfig {
  /** Demote when false-positive rate exceeds this fraction of verdicts. Default 0.30. */
  falsePositiveThreshold?: number;
  /** Demote once cumulative timeouts reach this count. Default 5. */
  timeoutThreshold?: number;
  /** Promote from probation once verdictsRequested ≥ this and accuracy ≥ 0.8. Default 20. */
  probationMinVerdicts?: number;
  /** Minimum accuracy ratio for promotion. Default 0.8. */
  probationMinAccuracy?: number;
}

export class OraclePeerGates implements LifecycleGates<OraclePeerAdapterProfile> {
  private readonly falsePositiveThreshold: number;
  private readonly timeoutThreshold: number;
  private readonly probationMinVerdicts: number;
  private readonly probationMinAccuracy: number;

  constructor(config: OraclePeerGatesConfig = {}) {
    this.falsePositiveThreshold = config.falsePositiveThreshold ?? 0.3;
    this.timeoutThreshold = config.timeoutThreshold ?? 5;
    this.probationMinVerdicts = config.probationMinVerdicts ?? 20;
    this.probationMinAccuracy = config.probationMinAccuracy ?? 0.8;
  }

  shouldPromote(profile: OraclePeerAdapterProfile): PromotionVerdict {
    const p = profile.raw;
    if (p.verdictsRequested < this.probationMinVerdicts) {
      return {
        promote: false,
        reason: `insufficient verdicts: ${p.verdictsRequested}/${this.probationMinVerdicts}`,
      };
    }
    const accuracy = p.verdictsRequested > 0 ? p.verdictsAccurate / p.verdictsRequested : 0;
    if (accuracy < this.probationMinAccuracy) {
      return {
        promote: false,
        reason: `accuracy ${accuracy.toFixed(3)} < ${this.probationMinAccuracy.toFixed(2)}`,
      };
    }
    return { promote: true, reason: 'probation observations met accuracy bar' };
  }

  shouldDemote(profile: OraclePeerAdapterProfile): DemotionVerdict {
    const p = profile.raw;
    if (p.verdictsRequested === 0) {
      return { demote: false, reason: 'no verdicts recorded' };
    }
    const fpRate = p.falsePositiveCount / p.verdictsRequested;
    if (fpRate > this.falsePositiveThreshold) {
      return {
        demote: true,
        reason: `false-positive rate ${fpRate.toFixed(3)} > ${this.falsePositiveThreshold.toFixed(2)}`,
      };
    }
    if (p.timeoutCount >= this.timeoutThreshold) {
      return {
        demote: true,
        reason: `timeouts ${p.timeoutCount} >= ${this.timeoutThreshold}`,
      };
    }
    return { demote: false, reason: 'within bounds' };
  }
}

// ── Adapter so OracleProfile fits AgentProfileBase + ProfileStore ──

/** Envelope that turns an OracleProfile into an AgentProfileBase for the generic lifecycle. */
export interface OraclePeerAdapterProfile extends AgentProfileBase {
  raw: OracleProfile;
}

/** Wraps OracleProfileStore as a ProfileStore<OraclePeerAdapterProfile>. */
export function wrapOracleProfileStore(store: OracleProfileStore): ProfileStore<OraclePeerAdapterProfile> {
  const wrap = (raw: OracleProfile): OraclePeerAdapterProfile => ({
    id: raw.id,
    status: raw.status,
    createdAt: raw.createdAt,
    demotedAt: raw.demotedAt,
    demotionReason: raw.demotionReason,
    demotionCount: raw.status === 'demoted' ? 1 : 0, // OracleProfile doesn't track count yet
    raw,
  });

  return {
    findById: (id) => {
      const p = store.getProfileById(id);
      return p ? wrap(p) : null;
    },
    findByStatus: (status: AgentProfileStatus) => store.findByStatus(status).map(wrap),
    findActive: () => store.findByStatus('active').map(wrap),
    updateStatus: (id, status, reason) => {
      if (status === 'active') store.promote(id);
      else if (status === 'demoted') store.demote(id, reason ?? 'demoted');
      else if (status === 'retired') store.retire(id);
      // probation back-transition not directly supported in legacy store
    },
  };
}
