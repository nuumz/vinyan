/**
 * `vinyan skills promote` — Phase-7 user-visible trigger of the
 * acquired→bound skill promoter.
 *
 * Two modes:
 *   - default (dry-run) — list proposals, persist nothing
 *   - `--apply`         — list proposals AND persist to `.vinyan/agents/<id>/skills.json`
 *
 * The proposer reads `SkillOutcomeStore` and proposes promotions for
 * (persona, skill) pairs whose Wilson LB on success rate clears
 * `WILSON_LB_FOR_PROMOTION` over `MIN_TRIALS_FOR_PROMOTION` outcomes. See
 * `src/orchestrator/agents/skill-promoter.ts` for thresholds.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SkillAdmissionStore } from '../db/skill-admission-store.ts';
import { SkillOutcomeStore } from '../db/skill-outcome-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { ParameterLedger } from '../orchestrator/adaptive-params/parameter-ledger.ts';
import { ParameterStore } from '../orchestrator/adaptive-params/parameter-store.ts';
import { loadAgentRegistry } from '../orchestrator/agents/registry.ts';
import {
  type AdmissionDeps,
  applyPromotions,
  type PromotionProposal,
  proposeAcquiredToBoundPromotions,
} from '../orchestrator/agents/skill-promoter.ts';
import { buildSyncSkillResolver } from '../skills/sync-skill-resolver.ts';

interface ParsedArgs {
  apply: boolean;
  showRejected: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let apply = false;
  let showRejected = false;
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a === '--show-rejected') showRejected = true;
    else if (a.startsWith('-')) {
      throw new Error(`Unknown flag '${a}'. Usage: vinyan skills promote [--apply] [--show-rejected]`);
    }
  }
  return { apply, showRejected };
}

function formatProposal(p: PromotionProposal): string {
  const total = p.successes + p.failures;
  const lb = p.wilsonLB.toFixed(3);
  return `  ${p.personaId} ← ${p.skillId}  (success ${p.successes}/${total}, wilsonLB=${lb}, evidence=${p.evidenceTaskSignature})`;
}

export async function runSkillPromoteCommand(argv: string[], workspace: string): Promise<void> {
  const { apply, showRejected } = parseArgs(argv);

  const dbPath = join(workspace, '.vinyan', 'vinyan.db');
  if (!existsSync(dbPath)) {
    console.error(`No Vinyan database at ${dbPath}. Run 'vinyan init' first.`);
    process.exit(1);
  }
  const db = new VinyanDB(dbPath);
  try {
    const store = new SkillOutcomeStore(db.getDb());
    const registry = loadAgentRegistry(workspace, undefined);

    // Phase B admission gate — wired in when a SKILL.md store exists. The
    // resolver is best-effort: if `.vinyan/skills/` is empty (fresh workspace
    // or skills installed elsewhere), the resolver returns null for every
    // skill, the gate conservative-skips them, and no proposals appear. That
    // is the correct degraded behavior — admission cannot opine on skills it
    // cannot read.
    const skillResolverResult = buildSyncSkillResolver(join(workspace, '.vinyan', 'skills'));
    const auditStore = new SkillAdmissionStore(db.getDb());
    const paramStore = new ParameterStore({ ledger: new ParameterLedger(db.getDb()) });
    const minOverlapRatio = paramStore.getNumber('skill.admission.min_overlap_ratio');

    const admission: AdmissionDeps = {
      skillResolver: skillResolverResult.resolver,
      auditStore,
      minOverlapRatio,
    };

    const proposals = proposeAcquiredToBoundPromotions(store, registry, workspace, admission);

    if (proposals.length === 0) {
      console.log('No promotion proposals — no (persona, skill) clears admission + Wilson LB + min-trials gates.');
      if (showRejected) printRejected(auditStore);
      return;
    }

    console.log(`${proposals.length} proposal${proposals.length === 1 ? '' : 's'}:`);
    for (const p of proposals) console.log(formatProposal(p));

    if (showRejected) printRejected(auditStore);

    if (!apply) {
      console.log('\n(dry-run — re-run with --apply to persist to .vinyan/agents/<persona>/skills.json)');
      return;
    }

    const applied = applyPromotions(workspace, proposals);
    console.log(`\nApplied ${applied.length} promotion${applied.length === 1 ? '' : 's'} to disk.`);
  } finally {
    // VinyanDB doesn't expose close, but ensure scope ends cleanly.
  }
}

function printRejected(auditStore: SkillAdmissionStore): void {
  const rejected = auditStore.listByVerdict('reject', 20);
  if (rejected.length === 0) {
    console.log('\nNo admission rejections in audit.');
    return;
  }
  console.log(`\n${rejected.length} admission rejection${rejected.length === 1 ? '' : 's'} (most recent 20):`);
  for (const r of rejected) {
    console.log(
      `  ${r.personaId} ✗ ${r.skillId}  (overlap=${r.overlapRatio.toFixed(3)}) — ${r.reason ?? 'no reason recorded'}`,
    );
  }
}
