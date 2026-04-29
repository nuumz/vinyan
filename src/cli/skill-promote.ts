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
import { SkillOutcomeStore } from '../db/skill-outcome-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { loadAgentRegistry } from '../orchestrator/agents/registry.ts';
import {
  applyPromotions,
  type PromotionProposal,
  proposeAcquiredToBoundPromotions,
} from '../orchestrator/agents/skill-promoter.ts';

interface ParsedArgs {
  apply: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let apply = false;
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a.startsWith('-')) {
      throw new Error(`Unknown flag '${a}'. Usage: vinyan skills promote [--apply]`);
    }
  }
  return { apply };
}

function formatProposal(p: PromotionProposal): string {
  const total = p.successes + p.failures;
  const lb = p.wilsonLB.toFixed(3);
  return `  ${p.personaId} ← ${p.skillId}  (success ${p.successes}/${total}, wilsonLB=${lb}, evidence=${p.evidenceTaskSignature})`;
}

export async function runSkillPromoteCommand(argv: string[], workspace: string): Promise<void> {
  const { apply } = parseArgs(argv);

  const dbPath = join(workspace, '.vinyan', 'vinyan.db');
  if (!existsSync(dbPath)) {
    console.error(`No Vinyan database at ${dbPath}. Run 'vinyan init' first.`);
    process.exit(1);
  }
  const db = new VinyanDB(dbPath);
  try {
    const store = new SkillOutcomeStore(db.getDb());
    const registry = loadAgentRegistry(workspace, undefined);

    const proposals = proposeAcquiredToBoundPromotions(store, registry, workspace);

    if (proposals.length === 0) {
      console.log('No promotion proposals — no (persona, skill) clears the Wilson LB / min-trials gates.');
      return;
    }

    console.log(`${proposals.length} proposal${proposals.length === 1 ? '' : 's'}:`);
    for (const p of proposals) console.log(formatProposal(p));

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
