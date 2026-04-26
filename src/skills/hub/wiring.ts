/**
 * `setupSkillImporter` — single factory that assembles a fully-wired
 * `SkillImporter` from its structural deps.
 *
 * Callers (e.g. `src/orchestrator/factory.ts`) supply the real
 * `runGate` + `CriticEngine`; this module produces the ledger, the two
 * narrow adapter fns, and the importer with guardrails wired in.
 *
 * Axiom anchors:
 *   - A1 Epistemic Separation: the adapters preserve the gate/critic as
 *     independent verifiers; they do not participate in the decision.
 *   - A3 Deterministic Governance: promotion rule + ledger stay rule-based.
 *   - A6 Zero-Trust Execution: guardrails default to permissive only when
 *     the caller explicitly opts out; a warn log flags the weakened posture.
 */
import type { Database } from 'bun:sqlite';
import { SkillTrustLedgerStore } from '../../db/skill-trust-ledger-store.ts';
import type { SkillArtifactStore } from '../artifact-store.ts';
import { buildImporterCriticFn, type CriticAdapterDeps } from './critic-adapter.ts';
import { buildImporterGateFn, type RunGateFn } from './gate-adapter.ts';
import {
  DEFAULT_IMPORTER_GUARDRAILS,
  type ImporterGuardrails,
  SkillImporter,
} from './importer.ts';
import type { SkillRegistryAdapter } from './registry-adapter.ts';
import { StoreBackedSkillTrustLedger, type SkillTrustLedger } from './trust-ledger.ts';

/**
 * Narrow guardrail shape accepted by `setupSkillImporter` — when present,
 * mapped to `ImporterGuardrails`. The shape matches the project-standard
 * guardrail entry points (`detectPromptInjection`, `containsBypassAttempt`)
 * stripped of their pattern-return detail (adapter lifts them to the full
 * shape).
 */
export interface SetupGuardrails {
  readonly detectInjection: (text: string) => boolean;
  readonly detectBypass: (text: string) => boolean;
}

export interface SetupSkillImporterOptions {
  readonly db: Database;
  readonly adapter: SkillRegistryAdapter;
  readonly runGate: RunGateFn;
  readonly critic: CriticAdapterDeps['critic'];
  readonly workspace: string;
  readonly profile: string;
  readonly artifactStore: SkillArtifactStore;
  /**
   * Optional custom guardrails. When absent, the real Vinyan guardrails
   * (`DEFAULT_IMPORTER_GUARDRAILS` → `detectPromptInjection` +
   * `containsBypassAttempt`) are used.
   *
   * Pass `{ permissive: true }` to bypass scanning entirely — emits a
   * single WARN log line on wire-up. Use only in sealed, trusted test
   * workspaces (A6 violation if used in production).
   */
  readonly guardrails?: SetupGuardrails | { readonly permissive: true };
  /** Override clock for tests (ms epoch). */
  readonly clock?: () => number;
  /** Log sink — defaults to `console.warn`. Tests can capture. */
  readonly warn?: (msg: string) => void;
}

export interface SkillImporterHandle {
  readonly importer: SkillImporter;
  readonly ledger: SkillTrustLedger;
  readonly ledgerStore: SkillTrustLedgerStore;
}

/**
 * Build the `SkillImporter` + its SQLite-backed trust ledger.
 *
 * The handle is intentionally a POJO so higher layers can store or
 * introspect any piece (e.g. registering the ledger for observability).
 */
export function setupSkillImporter(opts: SetupSkillImporterOptions): SkillImporterHandle {
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));

  const ledgerStore = new SkillTrustLedgerStore(opts.db);
  const ledger = new StoreBackedSkillTrustLedger({
    store: ledgerStore,
    profile: opts.profile,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });

  const gate = buildImporterGateFn({
    runGate: opts.runGate,
    workspace: opts.workspace,
  });
  const critic = buildImporterCriticFn({ critic: opts.critic });

  const guardrails = resolveGuardrails(opts.guardrails, warn);

  const importer = new SkillImporter({
    adapter: opts.adapter,
    gate,
    critic,
    guardrails,
    trustLedger: ledger,
    artifactStore: opts.artifactStore,
    profile: opts.profile,
    workspace: opts.workspace,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });

  return { importer, ledger, ledgerStore };
}

function resolveGuardrails(
  input: SetupSkillImporterOptions['guardrails'],
  warn: (msg: string) => void,
): ImporterGuardrails {
  if (!input) {
    return DEFAULT_IMPORTER_GUARDRAILS;
  }
  if ('permissive' in input) {
    warn(
      '[vinyan-skills-hub] setupSkillImporter: guardrails disabled (permissive=true). ' +
        'This bypasses injection + bypass scans. Safe ONLY for sealed, trusted test workspaces. (A6)',
    );
    return {
      detectInjection: () => ({ detected: false, patterns: [] }),
      detectBypass: () => ({ detected: false, patterns: [] }),
    };
  }
  const custom: SetupGuardrails = input;
  return {
    detectInjection: (text) => {
      const hit = custom.detectInjection(text);
      return { detected: hit, patterns: hit ? ['custom:injection'] : [] };
    },
    detectBypass: (text) => {
      const hit = custom.detectBypass(text);
      return { detected: hit, patterns: hit ? ['custom:bypass'] : [] };
    },
  };
}
