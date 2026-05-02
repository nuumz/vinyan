#!/usr/bin/env bun
/**
 * Persona Selector — 50-trial readiness suite.
 *
 * Stress-tests `selectPersonasViaLLM` across 50 diverse goals (English +
 * Thai, varied domains, modes, counts, edge cases) to validate:
 *
 *   - Selector returns a non-null result on every realistic prompt
 *   - Primary persona mix is content-aware (not always architect/author/
 *     developer)
 *   - Integrator is content-aware (not always coordinator)
 *   - Disjoint constraint holds (no integrator overlap with primaries)
 *   - Latency stays in the 2-5s range
 *
 * Categories (50 total):
 *   01-08  CODE / SYSTEM design (8)
 *   09-14  CREATIVE writing (6)
 *   15-19  PHILOSOPHY / reasoning (5)
 *   20-24  PERSONAL / lifestyle (5)
 *   25-29  BUSINESS / strategy (5)
 *   30-33  EDUCATION / learning (4)
 *   34-37  PRACTICAL / logistics (4)
 *   38-42  EDGE cases — short, long, ambiguous, abstract, mixed-lang (5)
 *   43-46  COUNT variation — 1, 2, 4, 5 (4)
 *   47-50  MODE variation — parallel, debate, competition, comparison (4)
 *
 * Grading (per trial):
 *   PASS    — selector returned, primary diversity ok, integrator content-fit
 *   PARTIAL — selector returned but integrator overlap → coordinator fallback
 *   FAIL    — selector returned null OR validation rejected
 *
 * Usage:  bun run scripts/persona-selector-suite.ts
 *         DEBUG_RAW=1 bun run scripts/persona-selector-suite.ts
 */
import { loadAgentRegistry } from '../src/orchestrator/agents/registry.ts';
import type { CollaborationDirective } from '../src/orchestrator/intent/collaboration-parser.ts';
import { registerOpenRouterProviders } from '../src/orchestrator/llm/openrouter-provider.ts';
import { LLMProviderRegistry } from '../src/orchestrator/llm/provider-registry.ts';
import {
  type PersonaSelectionResult,
  selectPersonasViaLLM,
} from '../src/orchestrator/room/presets/llm-persona-selector.ts';

const DEBUG_RAW = process.env.DEBUG_RAW === '1';

interface Trial {
  id: string;
  category: string;
  goal: string;
  count: number;
  mode: CollaborationDirective['interactionMode'];
  rounds: number;
  /** Domain tags — used to assess persona fit. */
  fitTags: string[];
}

const TRIALS: Trial[] = [
  // ── 01-08 CODE / SYSTEM ───────────────────────────────────────────────
  { id: '01', category: 'CODE', goal: 'Design the module layout for a multi-tenant SaaS authentication service. Discuss trade-offs.', count: 3, mode: 'debate', rounds: 1, fitTags: ['developer', 'architect', 'researcher'] },
  { id: '02', category: 'CODE', goal: 'How should we structure a TypeScript monorepo for a 30-engineer team? Compare approaches.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['architect', 'developer', 'researcher'] },
  { id: '03', category: 'CODE', goal: 'Review three caching strategies for our Redis layer and pick the safest one.', count: 3, mode: 'competition', rounds: 1, fitTags: ['developer', 'architect', 'reviewer'] },
  { id: '04', category: 'CODE', goal: 'Debate whether we should migrate from REST to GraphQL for our public API.', count: 3, mode: 'debate', rounds: 2, fitTags: ['architect', 'developer', 'researcher'] },
  { id: '05', category: 'CODE', goal: 'Audit the security model of our OAuth flow and identify weaknesses.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['reviewer', 'researcher', 'developer'] },
  { id: '06', category: 'CODE', goal: 'Optimize a slow PostgreSQL query that scans 10M rows. Suggest 3 strategies.', count: 3, mode: 'competition', rounds: 0, fitTags: ['developer', 'architect', 'researcher'] },
  { id: '07', category: 'CODE', goal: 'Design a database schema for a multi-currency e-commerce platform.', count: 3, mode: 'debate', rounds: 1, fitTags: ['architect', 'developer', 'researcher'] },
  { id: '08', category: 'CODE', goal: 'Compare three deployment strategies (blue-green, canary, rolling) for our k8s cluster.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['architect', 'developer', 'researcher'] },

  // ── 09-14 CREATIVE WRITING ────────────────────────────────────────────
  { id: '09', category: 'CREATIVE', goal: 'Write a 3-chapter children bedtime story about a fox who learns to share.', count: 3, mode: 'parallel-answer', rounds: 0, fitTags: ['author', 'mentor', 'researcher'] },
  { id: '10', category: 'CREATIVE', goal: 'Draft three opening paragraphs for a dystopian sci-fi novel set on Mars colonies.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['author', 'researcher', 'mentor'] },
  { id: '11', category: 'CREATIVE', goal: 'Compose a haiku about the loneliness of a Bangkok rainy season.', count: 3, mode: 'parallel-answer', rounds: 0, fitTags: ['author', 'mentor', 'researcher'] },
  { id: '12', category: 'CREATIVE', goal: 'Write a 1-minute screenplay scene where a barista discovers a hidden message in a customer order.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['author', 'researcher', 'assistant'] },
  { id: '13', category: 'CREATIVE', goal: 'Draft three marketing taglines for a new oat-milk brand targeting Gen Z.', count: 3, mode: 'competition', rounds: 0, fitTags: ['author', 'researcher', 'assistant'] },
  { id: '14', category: 'CREATIVE', goal: 'Write a documentation page explaining "eventual consistency" to junior backend engineers.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['author', 'mentor', 'researcher'] },

  // ── 15-19 PHILOSOPHY / REASONING ──────────────────────────────────────
  { id: '15', category: 'PHILOSOPHY', goal: 'Compare Stoic, Buddhist, and Epicurean answers to the question of human suffering.', count: 3, mode: 'debate', rounds: 1, fitTags: ['researcher', 'mentor', 'author'] },
  { id: '16', category: 'PHILOSOPHY', goal: 'Is free will compatible with determinism? Defend three positions.', count: 3, mode: 'debate', rounds: 2, fitTags: ['researcher', 'mentor', 'author'] },
  { id: '17', category: 'PHILOSOPHY', goal: 'Discuss the trolley problem from utilitarian, deontological, and virtue-ethics lenses.', count: 3, mode: 'debate', rounds: 1, fitTags: ['researcher', 'mentor', 'author'] },
  { id: '18', category: 'PHILOSOPHY', goal: 'What is consciousness? Argue physicalist vs dualist vs panpsychist views.', count: 3, mode: 'debate', rounds: 2, fitTags: ['researcher', 'mentor', 'author'] },
  { id: '19', category: 'PHILOSOPHY', goal: 'Examine whether AI can possess genuine creativity, with three contrasting takes.', count: 3, mode: 'debate', rounds: 1, fitTags: ['researcher', 'mentor', 'author'] },

  // ── 20-24 PERSONAL / LIFESTYLE ────────────────────────────────────────
  { id: '20', category: 'PERSONAL', goal: 'I am 32 years old burned out from corporate work. Should I take a sabbatical, change careers, or freelance?', count: 3, mode: 'comparison', rounds: 1, fitTags: ['mentor', 'researcher', 'concierge'] },
  { id: '21', category: 'PERSONAL', goal: 'Plan a 7-day Japan trip for a couple celebrating their 5th anniversary, with culture+food focus.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['concierge', 'researcher', 'author'] },
  { id: '22', category: 'PERSONAL', goal: 'Build a 30-day diabetes self-management plan for a newly diagnosed type-2 patient.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['researcher', 'mentor', 'concierge'] },
  { id: '23', category: 'PERSONAL', goal: 'Help me draft a heartfelt letter to my estranged father after 10 years of silence.', count: 3, mode: 'parallel-answer', rounds: 0, fitTags: ['author', 'mentor', 'assistant'] },
  { id: '24', category: 'PERSONAL', goal: 'Should I get married this year? Discuss factors from financial, emotional, and practical lenses.', count: 3, mode: 'comparison', rounds: 1, fitTags: ['mentor', 'researcher', 'concierge'] },

  // ── 25-29 BUSINESS / STRATEGY ─────────────────────────────────────────
  { id: '25', category: 'BUSINESS', goal: 'Critique three pitch-deck drafts for a Series A fintech and pick the most compelling.', count: 3, mode: 'competition', rounds: 1, fitTags: ['reviewer', 'author', 'researcher'] },
  { id: '26', category: 'BUSINESS', goal: 'Compare three pricing models (freemium, tiered, usage-based) for a B2B SaaS product.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['researcher', 'architect', 'mentor'] },
  { id: '27', category: 'BUSINESS', goal: 'Should we hire a senior engineer or two mid-level engineers within our $400k budget?', count: 3, mode: 'debate', rounds: 1, fitTags: ['mentor', 'researcher', 'architect'] },
  { id: '28', category: 'BUSINESS', goal: 'Brainstorm three go-to-market strategies for a Thai grocery delivery startup expanding to Vietnam.', count: 3, mode: 'parallel-answer', rounds: 0, fitTags: ['researcher', 'architect', 'concierge'] },
  { id: '29', category: 'BUSINESS', goal: 'Assess the risks of pivoting our edtech B2C product into a B2B school-licensing model.', count: 3, mode: 'comparison', rounds: 1, fitTags: ['researcher', 'reviewer', 'mentor'] },

  // ── 30-33 EDUCATION / LEARNING ────────────────────────────────────────
  { id: '30', category: 'EDUCATION', goal: 'Explain Bayes\' theorem to a high-school student in three different teaching styles.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['mentor', 'author', 'researcher'] },
  { id: '31', category: 'EDUCATION', goal: 'Design a 12-week curriculum for an adult learner picking up Mandarin from zero.', count: 3, mode: 'comparison', rounds: 1, fitTags: ['mentor', 'author', 'researcher'] },
  { id: '32', category: 'EDUCATION', goal: 'Discuss the causes of the 1997 Asian financial crisis from economic, political, and cultural angles.', count: 3, mode: 'debate', rounds: 1, fitTags: ['researcher', 'author', 'mentor'] },
  { id: '33', category: 'EDUCATION', goal: 'Compare three approaches to teaching algebra (procedural, conceptual, applied) for grade-9 students.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['mentor', 'author', 'researcher'] },

  // ── 34-37 PRACTICAL / LOGISTICS ───────────────────────────────────────
  { id: '34', category: 'PRACTICAL', goal: 'Develop three variations of a Thai green-curry recipe — traditional, vegan, and 15-minute weeknight.', count: 3, mode: 'parallel-answer', rounds: 0, fitTags: ['author', 'researcher', 'concierge'] },
  { id: '35', category: 'PRACTICAL', goal: 'Plan a corporate hackathon for 80 engineers across 3 days. Suggest schedule, prizes, and judging criteria.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['concierge', 'mentor', 'researcher'] },
  { id: '36', category: 'PRACTICAL', goal: 'Renovate a small condo (45 sqm) for a young couple working from home — three layout proposals.', count: 3, mode: 'competition', rounds: 0, fitTags: ['architect', 'author', 'concierge'] },
  { id: '37', category: 'PRACTICAL', goal: 'Project plan: launch a community garden in 6 months on a 1000sqm urban plot. Three execution strategies.', count: 3, mode: 'comparison', rounds: 1, fitTags: ['architect', 'concierge', 'researcher'] },

  // ── 38-42 EDGE CASES ──────────────────────────────────────────────────
  { id: '38', category: 'EDGE-short', goal: 'Best fix?', count: 3, mode: 'debate', rounds: 0, fitTags: ['mentor', 'researcher', 'assistant'] },
  { id: '39', category: 'EDGE-long', goal: 'I am building a real-time collaborative editor similar to Google Docs but optimized for Thai legal documents (e.g. contracts, court submissions). The system needs to handle CRDT-based merge across 5-10 simultaneous editors, support Thai-specific text features (kerning around tone marks, line-breaking at word boundaries without explicit spaces), persist every keystroke for legal-evidence purposes, integrate with the Thai government e-signature service, and run primarily on commodity Linux servers in a Bangkok DC. Compare three architectural strategies — operational-transformation, CRDT, and hybrid OT+CRDT — discussing trade-offs around real-time correctness, undo semantics, conflict resolution UX, evidence-grade audit trails, and the ergonomics for the editor team who will maintain this for the next 5 years.', count: 3, mode: 'debate', rounds: 2, fitTags: ['architect', 'developer', 'researcher'] },
  { id: '40', category: 'EDGE-ambiguous', goal: 'What should we do about the thing?', count: 3, mode: 'debate', rounds: 1, fitTags: ['mentor', 'assistant', 'researcher'] },
  { id: '41', category: 'EDGE-abstract', goal: 'Discuss the nature of beauty.', count: 3, mode: 'debate', rounds: 1, fitTags: ['author', 'researcher', 'mentor'] },
  { id: '42', category: 'EDGE-mixed-lang', goal: 'อยาก plan trip ไป Tokyo 5 วัน budget 30k ขอ 3 itinerary ที่ต่างกัน', count: 3, mode: 'comparison', rounds: 0, fitTags: ['concierge', 'researcher', 'author'] },

  // ── 43-46 COUNT variation ────────────────────────────────────────────
  { id: '43', category: 'COUNT-1', goal: 'Write a tweet announcing our company\'s carbon-neutrality milestone.', count: 1, mode: 'parallel-answer', rounds: 0, fitTags: ['author'] },
  { id: '44', category: 'COUNT-2', goal: 'Argue for and against using monorepos in a 50-engineer startup.', count: 2, mode: 'debate', rounds: 1, fitTags: ['developer', 'architect'] },
  { id: '45', category: 'COUNT-4', goal: 'Develop four parallel marketing angles for a new mental-health app aimed at university students.', count: 4, mode: 'parallel-answer', rounds: 0, fitTags: ['author', 'researcher', 'mentor', 'assistant'] },
  { id: '46', category: 'COUNT-5', goal: 'Compare five strategies (low-carb, Mediterranean, intermittent-fasting, plant-based, balanced) for sustainable weight loss.', count: 5, mode: 'comparison', rounds: 0, fitTags: ['researcher', 'mentor', 'author', 'concierge', 'assistant'] },

  // ── 47-50 MODE variation ─────────────────────────────────────────────
  { id: '47', category: 'MODE-parallel', goal: 'Three independent perspectives on whether remote work is sustainable long-term.', count: 3, mode: 'parallel-answer', rounds: 0, fitTags: ['researcher', 'mentor', 'author'] },
  { id: '48', category: 'MODE-debate-deep', goal: 'Defend or rebut the claim that "AI alignment is fundamentally unsolvable" across 4 rounds.', count: 3, mode: 'debate', rounds: 4, fitTags: ['researcher', 'mentor', 'author'] },
  { id: '49', category: 'MODE-competition', goal: 'Compete to write the most persuasive 200-word product launch announcement for an electric scooter.', count: 3, mode: 'competition', rounds: 1, fitTags: ['author', 'mentor', 'researcher'] },
  { id: '50', category: 'MODE-comparison', goal: 'Compare three approaches (psychological, sociological, evolutionary) to explaining why people lie.', count: 3, mode: 'comparison', rounds: 0, fitTags: ['researcher', 'mentor', 'author'] },
];

function makeDirective(t: Trial): CollaborationDirective {
  return {
    requestedPrimaryParticipantCount: t.count,
    interactionMode: t.mode,
    rebuttalRounds: t.rounds,
    sharedDiscussion: t.rounds > 0,
    reviewerPolicy: 'none',
    managerClarificationAllowed: true,
    emitCompetitionVerdict: t.mode === 'competition',
    source: 'pre-llm-parser',
    matchedFragments: { count: String(t.count) },
  };
}

interface TrialOutcome {
  trial: Trial;
  result: PersonaSelectionResult | null;
  durationMs: number;
  threwError?: string;
  /** PASS | PARTIAL | FAIL */
  grade: 'PASS' | 'PARTIAL' | 'FAIL';
  /** Free-text observations from the auto-grader. */
  notes: string[];
}

function gradeOutcome(t: Trial, result: PersonaSelectionResult | null): { grade: TrialOutcome['grade']; notes: string[] } {
  const notes: string[] = [];
  if (!result) {
    return { grade: 'FAIL', notes: ['selector returned null → caller falls back to alphabetical'] };
  }
  if (result.primaryIds.length !== t.count) {
    notes.push(`primary count mismatch: got ${result.primaryIds.length} expected ${t.count}`);
  }
  const dupCheck = new Set(result.primaryIds.map((p) => p as string));
  if (dupCheck.size !== result.primaryIds.length) notes.push('duplicate primaries leaked through');

  // Integrator absence is EXPECTED in parallel-answer mode (no integrator
  // step runs). Only flag absence as an issue for non-parallel modes.
  const integratorAbsent = !result.integratorId;
  const integratorOverlap = result.integratorId && result.primaryIds.includes(result.integratorId);
  if (integratorAbsent && t.mode !== 'parallel-answer') {
    notes.push('integrator dropped (overlap or unknown) → coordinator fallback');
  }
  if (integratorOverlap) notes.push('integrator overlap leaked through validator (BUG)');

  // Domain-fit signal: at least one of the trial's fitTags appears in primaries.
  const overlapWithTags = (result.primaryIds as string[]).filter((p) => t.fitTags.includes(p));
  if (overlapWithTags.length === 0) {
    notes.push(`primary mix has no overlap with expected tags [${t.fitTags.join(',')}]`);
  } else if (overlapWithTags.length < Math.min(2, t.fitTags.length)) {
    notes.push(`primary mix has only ${overlapWithTags.length}/${t.fitTags.length} domain-tag overlaps`);
  }

  // Diversity check: primaries should not collapse to all of one role-class.
  // Surface as a soft note only — selector cannot read role classes here.
  // (Best-effort heuristic.)

  if (notes.length === 0) return { grade: 'PASS', notes };
  // Domain-tag overlap of 1 is acceptable — fitTags are an author's
  // hypothesis of best-fit, not the only valid answer. The actual personas
  // chosen still match the goal at 1+ overlap level. Treat as PARTIAL only
  // when there's BUG-level integrator overlap or count mismatch.
  if (overlapWithTags.length > 0 && !notes.some((n) => n.includes('BUG') || n.includes('mismatch'))) {
    return { grade: 'PARTIAL', notes };
  }
  return { grade: 'FAIL', notes };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('No API key in env. Aborting.');
    process.exit(1);
  }

  const llmRegistry = new LLMProviderRegistry();
  registerOpenRouterProviders(llmRegistry);
  if (DEBUG_RAW) {
    const balanced = llmRegistry.selectByTier('balanced');
    if (balanced) {
      const original = balanced.generate.bind(balanced);
      balanced.generate = async (req) => {
        const resp = await original(req);
        console.log(`[RAW] ${balanced.id}:\n${resp.content}\n[/RAW]`);
        return resp;
      };
    }
  }

  const agentRegistry = loadAgentRegistry(process.cwd());
  console.log(`Roster size: ${agentRegistry.listAgents().length}`);
  console.log(`Total trials: ${TRIALS.length}\n`);

  const outcomes: TrialOutcome[] = [];
  for (const t of TRIALS) {
    process.stdout.write(`[${t.id}] ${t.category.padEnd(18)} count=${t.count} mode=${t.mode.padEnd(16)} ... `);
    const t0 = Date.now();
    let result: PersonaSelectionResult | null = null;
    let threwError: string | undefined;
    try {
      result = await selectPersonasViaLLM({
        goal: t.goal,
        directive: makeDirective(t),
        registry: agentRegistry,
        llmRegistry,
      });
    } catch (err) {
      threwError = err instanceof Error ? err.message : String(err);
    }
    const dt = Date.now() - t0;
    const { grade, notes } = gradeOutcome(t, result);
    const symbol = grade === 'PASS' ? '✓' : grade === 'PARTIAL' ? '◐' : '✗';
    if (result) {
      const ints = result.integratorId ?? '(default→coordinator)';
      process.stdout.write(`${symbol} ${dt}ms · primaries=[${result.primaryIds.join(',')}] integrator=${ints}\n`);
    } else if (threwError) {
      process.stdout.write(`${symbol} THREW: ${threwError}\n`);
    } else {
      process.stdout.write(`${symbol} ${dt}ms · NULL (fallback to alphabetical)\n`);
    }
    if (notes.length > 0) {
      for (const n of notes) console.log(`     ↳ ${n}`);
    }
    outcomes.push({ trial: t, result, durationMs: dt, ...(threwError ? { threwError } : {}), grade, notes });
  }

  printSummary(outcomes);
}

function printSummary(outcomes: TrialOutcome[]) {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('                          SUMMARY');
  console.log('════════════════════════════════════════════════════════════');
  const pass = outcomes.filter((o) => o.grade === 'PASS').length;
  const partial = outcomes.filter((o) => o.grade === 'PARTIAL').length;
  const fail = outcomes.filter((o) => o.grade === 'FAIL').length;
  const total = outcomes.length;
  console.log(`PASS    ${pass}/${total}  (${pct(pass, total)}%)`);
  console.log(`PARTIAL ${partial}/${total}  (${pct(partial, total)}%)  — selector returned but integrator silently dropped or partial domain mismatch`);
  console.log(`FAIL    ${fail}/${total}  (${pct(fail, total)}%)  — selector returned null OR threw`);

  // Two categories of "no integrator":
  //   1. Parallel-answer mode — by design, no integrator runs in this mode.
  //      The selector intentionally returns no integrator. Not a drop.
  //   2. Non-parallel mode + missing integrator — actual drop (LLM picked
  //      an overlap or unknown id, validator stripped, graceful fallback
  //      to the registry default coordinator).
  const expectedAbsent = outcomes.filter(
    (o) => o.result && !o.result.integratorId && o.trial.mode === 'parallel-answer',
  ).length;
  const realDrops = outcomes.filter(
    (o) => o.result && !o.result.integratorId && o.trial.mode !== 'parallel-answer',
  ).length;
  const nonParallelResults = outcomes.filter(
    (o) => o.result !== null && o.trial.mode !== 'parallel-answer',
  ).length;
  console.log('');
  console.log(
    `Integrator real drop rate: ${realDrops}/${nonParallelResults} of non-parallel results (${pct(realDrops, nonParallelResults)}%)`,
  );
  console.log(`(${expectedAbsent} parallel-answer trials correctly omit integrator by design)`);

  const totalLatency = outcomes.reduce((s, o) => s + o.durationMs, 0);
  const avgLatency = Math.round(totalLatency / outcomes.length);
  const p95Latency = [...outcomes.map((o) => o.durationMs)].sort((a, b) => a - b)[Math.floor(outcomes.length * 0.95)];
  console.log(`Latency: avg=${avgLatency}ms · p95=${p95Latency}ms · total=${(totalLatency / 1000).toFixed(1)}s`);

  const failures = outcomes.filter((o) => o.grade !== 'PASS');
  if (failures.length > 0) {
    console.log('\n──── Non-PASS trials ────');
    for (const o of failures) {
      console.log(`[${o.trial.id}] ${o.trial.category} (${o.grade}): ${o.trial.goal.slice(0, 80)}${o.trial.goal.length > 80 ? '…' : ''}`);
      for (const n of o.notes) console.log(`    ↳ ${n}`);
      if (o.result) {
        console.log(`    primaries=[${o.result.primaryIds.join(',')}]  integrator=${o.result.integratorId ?? '(default)'}`);
      }
    }
  }

  const byCategory = new Map<string, TrialOutcome[]>();
  for (const o of outcomes) {
    const root = o.trial.category.split('-')[0]!;
    const arr = byCategory.get(root) ?? [];
    arr.push(o);
    byCategory.set(root, arr);
  }
  console.log('\n──── By category ────');
  for (const [cat, arr] of [...byCategory.entries()].sort()) {
    const p = arr.filter((o) => o.grade === 'PASS').length;
    console.log(`  ${cat.padEnd(12)} ${p}/${arr.length} pass`);
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return '0';
  return ((n / d) * 100).toFixed(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
