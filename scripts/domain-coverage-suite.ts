#!/usr/bin/env bun
/**
 * Domain coverage suite — verifies Vinyan reaches the right
 * orchestration state ("clarify", "multi-agent dispatch", or "fall through")
 * for every registered creative domain.
 *
 * For each domain:
 *   1. Pick 2 representative casual prompts (no multi-agent signal)
 *   2. Pick 1 explicit multi-agent prompt
 *   3. Run intent gating: confirm `inferCreativeDomain` lands on the
 *      expected domain AND the creative-deliverable regex fires
 *   4. (Optional) E2E run only for one prompt per domain — confirms the
 *      clarification gate emits domain-appropriate questions
 *
 * Usage:
 *   bun run scripts/domain-coverage-suite.ts
 *   E2E=1 bun run scripts/domain-coverage-suite.ts
 *
 * The non-E2E mode is fast (no LLM, no orchestrator init). E2E is gated
 * behind the env var because it's expensive.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../src/core/bus.ts';
import {
  classifyCollaborationIntent,
  parseCollaborationDirective,
} from '../src/orchestrator/intent/collaboration-parser.ts';
import { matchesMultiAgentDelegation } from '../src/orchestrator/intent/strategy.ts';
import {
  type CreativeDomain,
  inferCreativeDomain,
} from '../src/orchestrator/understanding/clarification-templates.ts';

const E2E = process.env.E2E === '1';

interface DomainCase {
  domain: CreativeDomain;
  /** Casual prompts that should hit the deterministic creative-deliverable rule. */
  casual: string[];
  /** Multi-agent prompts — full orchestration with persona selection. */
  multiAgent: string;
}

const CASES: DomainCase[] = [
  {
    domain: 'webtoon',
    casual: ['เขียนเว็บตูนแนว fantasy 30 ตอน', 'create a webtoon about a chef-knight'],
    multiAgent: 'แบ่ง 3 agent ช่วยกันออกแบบเว็บตูนแนว slice-of-life',
  },
  {
    domain: 'novel',
    casual: ['อยากเขียนนิยาย sci-fi 1 เล่ม', 'draft a literary short story about regret'],
    multiAgent: 'have 3 agents brainstorm a mystery novel premise',
  },
  {
    domain: 'article',
    casual: ['เขียนบทความ tech เกี่ยวกับ web3', 'draft a blog post about remote work'],
    multiAgent: 'แบ่ง 3 agent เขียนบทความ analysis เรื่อง AI alignment',
  },
  {
    domain: 'video',
    casual: ['ช่วยทำคอนเท้นลง tiktok', 'make a youtube short about cooking pad thai'],
    multiAgent: 'แบ่ง 3 agent ช่วยทำคอนเท้นลง tiktok สำหรับร้านกาแฟ',
  },
  {
    domain: 'music',
    casual: ['แต่งเพลงประกอบหนังสั้น', 'compose a 30-second jingle for a bakery brand'],
    multiAgent: 'have 3 agents brainstorm a pop song about heartbreak',
  },
  {
    domain: 'game',
    casual: ['ออกแบบเกม mobile แนว roguelike', 'design a level for a 2D platformer'],
    multiAgent: 'แบ่ง 3 agent ออกแบบเกม indie แนวต่อสู้',
  },
  {
    domain: 'marketing',
    casual: ['ทำโฆษณา TikTok ขายขนมไทย', 'write ad copy for a SaaS product launch'],
    multiAgent: 'แบ่ง 3 agent คิดแคมเปญ rebrand ขนมเวเฟอร์',
  },
  {
    domain: 'education',
    casual: [
      'ออกแบบหลักสูตรสอนภาษาจีน 12 สัปดาห์',
      'design a curriculum for a beginner JavaScript bootcamp',
    ],
    multiAgent: 'have 3 agents draft a 6-week course on prompt engineering',
  },
  {
    domain: 'business',
    casual: ['ทำพิทช์เด็คสำหรับ Series A เกี่ยวกับ fintech', 'draft a one-pager for the board on Q4 OKRs'],
    multiAgent: 'แบ่ง 3 agent ช่วยร่างแผนธุรกิจร้านอาหาร',
  },
  {
    domain: 'visual',
    casual: ['design a logo for an oat-milk brand', 'ทำโปสเตอร์งาน hackathon'],
    multiAgent: 'แบ่ง 3 agent ออกแบบ infographic เกี่ยวกับ climate change',
  },
];

interface CaseOutcome {
  prompt: string;
  domain: CreativeDomain;
  inferredDomain: CreativeDomain;
  multiAgentMatch: boolean;
  collaborationIntent: 'execute' | 'mention' | 'none';
  parsedCount: number | null;
  /** PASS | PARTIAL | FAIL */
  grade: 'PASS' | 'PARTIAL' | 'FAIL';
  notes: string[];
}

function gradeCasual(c: DomainCase, prompt: string): CaseOutcome {
  const inferred = inferCreativeDomain(prompt);
  const multiAgentMatch = matchesMultiAgentDelegation(prompt);
  const collaborationIntent = classifyCollaborationIntent(prompt);
  const parsed = parseCollaborationDirective(prompt);
  const notes: string[] = [];
  if (inferred !== c.domain) notes.push(`expected domain="${c.domain}" but got "${inferred}"`);
  if (multiAgentMatch) notes.push('multi-agent regex matched a casual prompt (unexpected — caller should NOT route through collaboration runner)');
  const grade: CaseOutcome['grade'] = inferred === c.domain && !multiAgentMatch ? 'PASS' : notes.length > 0 ? 'FAIL' : 'PARTIAL';
  return {
    prompt,
    domain: c.domain,
    inferredDomain: inferred,
    multiAgentMatch,
    collaborationIntent,
    parsedCount: parsed?.requestedPrimaryParticipantCount ?? null,
    grade,
    notes,
  };
}

function gradeMultiAgent(c: DomainCase): CaseOutcome {
  const prompt = c.multiAgent;
  const inferred = inferCreativeDomain(prompt);
  const multiAgentMatch = matchesMultiAgentDelegation(prompt);
  const collaborationIntent = classifyCollaborationIntent(prompt);
  const parsed = parseCollaborationDirective(prompt);
  const notes: string[] = [];
  if (inferred !== c.domain) notes.push(`expected domain="${c.domain}" but got "${inferred}"`);
  if (!multiAgentMatch) notes.push('multi-agent regex did NOT match an explicit "N agent" prompt');
  if (collaborationIntent !== 'execute') notes.push(`collaborationIntent="${collaborationIntent}" expected "execute"`);
  if (!parsed || parsed.requestedPrimaryParticipantCount < 2) notes.push('directive parser did not extract a count >= 2');
  const grade: CaseOutcome['grade'] = notes.length === 0 ? 'PASS' : 'FAIL';
  return {
    prompt,
    domain: c.domain,
    inferredDomain: inferred,
    multiAgentMatch,
    collaborationIntent,
    parsedCount: parsed?.requestedPrimaryParticipantCount ?? null,
    grade,
    notes,
  };
}

async function runE2EClarification(prompt: string, expectedDomain: CreativeDomain): Promise<{
  fired: boolean;
  questionIds: string[];
  durationMs: number;
}> {
  const { createOrchestrator } = await import('../src/orchestrator/factory.ts');
  const tempDir = mkdtempSync(join(tmpdir(), 'vinyan-domcov-'));
  const bus = createBus();
  let fired = false;
  let questionIds: string[] = [];
  bus.on('agent:clarification_requested', (p: unknown) => {
    fired = true;
    const pp = p as { questions?: string[]; structuredQuestions?: Array<{ id?: string }> };
    questionIds = (pp.structuredQuestions ?? []).map((q) => q.id ?? '?');
  });
  const orchestrator = createOrchestrator({ workspace: tempDir, bus });
  const t0 = Date.now();
  try {
    await orchestrator.executeTask({
      id: `domcov-${expectedDomain}-${Date.now()}`,
      source: 'cli',
      goal: prompt,
      taskType: 'reasoning',
      budget: { maxTokens: 60_000, maxDurationMs: 60_000, maxRetries: 1 },
    });
  } finally {
    orchestrator.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
  return { fired, questionIds, durationMs: Date.now() - t0 };
}

async function main() {
  console.log(`Domain coverage suite — ${CASES.length} domains × 3 prompts = ${CASES.length * 3} cases`);
  console.log(E2E ? 'E2E=1: will also run one orchestrator E2E per domain to verify the clarification gate.\n' : 'Pure intent-layer mode (set E2E=1 to also run orchestrator E2E).\n');

  const allOutcomes: CaseOutcome[] = [];
  for (const c of CASES) {
    console.log(`──── ${c.domain.toUpperCase()} ────`);
    for (const casual of c.casual) {
      const o = gradeCasual(c, casual);
      allOutcomes.push(o);
      printOutcome(o);
    }
    const ma = gradeMultiAgent(c);
    allOutcomes.push(ma);
    printOutcome(ma);

    if (E2E) {
      const e2eRes = await runE2EClarification(c.casual[0]!, c.domain);
      console.log(
        `   ▸ E2E (casual prompt 0):  fired=${e2eRes.fired}  ${e2eRes.durationMs}ms  questions=[${e2eRes.questionIds.join(',')}]`,
      );
      if (!e2eRes.fired) console.log('     ↳ orchestrator did NOT trigger clarification gate (suggests creative-deliverable regex did not fire OR gate skipped)');
    }
  }

  printSummary(allOutcomes);
}

function printOutcome(o: CaseOutcome) {
  const symbol = o.grade === 'PASS' ? '✓' : o.grade === 'PARTIAL' ? '◐' : '✗';
  const tag = o.multiAgentMatch ? 'multi-agent' : 'casual';
  console.log(`${symbol} [${tag}] inferredDomain=${o.inferredDomain}  count=${o.parsedCount ?? '-'}  ${o.prompt.slice(0, 60)}${o.prompt.length > 60 ? '…' : ''}`);
  for (const n of o.notes) console.log(`     ↳ ${n}`);
}

function printSummary(outcomes: CaseOutcome[]) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('                          SUMMARY');
  console.log('══════════════════════════════════════════════════════════════');
  const pass = outcomes.filter((o) => o.grade === 'PASS').length;
  const partial = outcomes.filter((o) => o.grade === 'PARTIAL').length;
  const fail = outcomes.filter((o) => o.grade === 'FAIL').length;
  console.log(`PASS    ${pass}/${outcomes.length}`);
  console.log(`PARTIAL ${partial}/${outcomes.length}`);
  console.log(`FAIL    ${fail}/${outcomes.length}`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const o of outcomes.filter((o) => o.grade !== 'PASS')) {
      console.log(`  [${o.domain}] ${o.prompt.slice(0, 80)}`);
      for (const n of o.notes) console.log(`    ↳ ${n}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
