/**
 * SkillTrustLedger — thin façade over `SkillTrustLedgerStore`.
 *
 * The importer writes to the ledger through this narrow interface so that
 * tests can swap in an in-memory fake without touching SQLite. Every
 * transition the state machine makes flows through `.record()`.
 *
 * Axiom anchor: A3 Deterministic Governance — the ledger is the replay log
 * that proves promote/demote/reject followed the rule, not an LLM.
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import type {
  SkillTrustEvent,
  SkillTrustLedgerRecord,
  SkillTrustLedgerStore,
  SkillTrustStatus,
} from '../../db/skill-trust-ledger-store.ts';

export interface SkillTrustLedgerEntry {
  readonly event: SkillTrustEvent;
  readonly detail: Record<string, unknown>;
  readonly fromStatus?: SkillTrustStatus;
  readonly toStatus?: SkillTrustStatus;
  readonly fromTier?: ConfidenceTier;
  readonly toTier?: ConfidenceTier;
  readonly ruleId?: string;
}

export interface SkillTrustLedger {
  record(skillId: string, entry: SkillTrustLedgerEntry): void;
  history(skillId: string): readonly SkillTrustLedgerRecord[];
}

export interface SkillTrustLedgerOptions {
  readonly store: SkillTrustLedgerStore;
  readonly profile: string;
  readonly clock?: () => number;
}

export class StoreBackedSkillTrustLedger implements SkillTrustLedger {
  private readonly store: SkillTrustLedgerStore;
  private readonly profile: string;
  private readonly clock: () => number;

  constructor(opts: SkillTrustLedgerOptions) {
    this.store = opts.store;
    this.profile = opts.profile;
    this.clock = opts.clock ?? (() => Date.now());
  }

  record(skillId: string, entry: SkillTrustLedgerEntry): void {
    this.store.record({
      profile: this.profile,
      skillId,
      event: entry.event,
      evidence: entry.detail,
      createdAt: this.clock(),
      ...(entry.fromStatus ? { fromStatus: entry.fromStatus } : {}),
      ...(entry.toStatus ? { toStatus: entry.toStatus } : {}),
      ...(entry.fromTier ? { fromTier: entry.fromTier } : {}),
      ...(entry.toTier ? { toTier: entry.toTier } : {}),
      ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
    });
  }

  history(skillId: string): readonly SkillTrustLedgerRecord[] {
    return this.store.history(skillId, { profile: this.profile });
  }
}

/**
 * In-memory ledger for tests. Records stay in an array; identical API to
 * the store-backed ledger.
 */
export class InMemorySkillTrustLedger implements SkillTrustLedger {
  private readonly rows: SkillTrustLedgerRecord[] = [];
  private readonly clock: () => number;

  constructor(
    private readonly profile: string = 'default',
    clock?: () => number,
  ) {
    this.clock = clock ?? (() => Date.now());
  }

  record(skillId: string, entry: SkillTrustLedgerEntry): void {
    this.rows.push({
      profile: this.profile,
      skillId,
      event: entry.event,
      evidence: entry.detail,
      createdAt: this.clock(),
      ...(entry.fromStatus ? { fromStatus: entry.fromStatus } : {}),
      ...(entry.toStatus ? { toStatus: entry.toStatus } : {}),
      ...(entry.fromTier ? { fromTier: entry.fromTier } : {}),
      ...(entry.toTier ? { toTier: entry.toTier } : {}),
      ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
    });
  }

  history(skillId: string): readonly SkillTrustLedgerRecord[] {
    return this.rows.filter((r) => r.skillId === skillId);
  }

  all(): readonly SkillTrustLedgerRecord[] {
    return this.rows;
  }
}
