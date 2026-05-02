#!/usr/bin/env bun
/**
 * Audit — does the CREATIVE_DELIVERABLE regex catch every casual prompt
 * in the domain coverage suite?
 *
 * Without a match, casual prompts (no multi-agent signal) fall through
 * to STU classification → fallbackStrategy → likely direct-tool with no
 * command → 5+ minute pipeline stuck. Matching the regex forces
 * `agentic-workflow` strategy at confidence 0.9 so the workflow planner
 * + creative-clarification gate kick in.
 */
import { describe } from 'node:test';
import { matchesMultiAgentDelegation } from '../src/orchestrator/intent/strategy.ts';
import {
  type CreativeDomain,
  inferCreativeDomain,
} from '../src/orchestrator/understanding/clarification-templates.ts';

// Re-import the regex via a small probe — strategy.ts doesn't export
// `matchesCreativeDeliverable`, so we'll load the module and test against
// a representative function. We only need to confirm regex ergonomics, so
// we expose a runtime probe by reading the source if needed; simpler: test
// the public surface (composeDeterministicCandidate) via fixtures.
import { composeDeterministicCandidate } from '../src/orchestrator/intent/strategy.ts';
import type { TaskInput, SemanticTaskUnderstanding } from '../src/orchestrator/types.ts';

const PROMPTS: Array<{ domain: CreativeDomain; prompt: string }> = [
  { domain: 'webtoon', prompt: 'เขียนเว็บตูนแนว fantasy 30 ตอน' },
  { domain: 'webtoon', prompt: 'create a webtoon about a chef-knight' },
  { domain: 'novel', prompt: 'อยากเขียนนิยาย sci-fi 1 เล่ม' },
  { domain: 'novel', prompt: 'draft a literary short story about regret' },
  { domain: 'article', prompt: 'เขียนบทความ tech เกี่ยวกับ web3' },
  { domain: 'article', prompt: 'draft a blog post about remote work' },
  { domain: 'video', prompt: 'ช่วยทำคอนเท้นลง tiktok' },
  { domain: 'video', prompt: 'make a youtube short about cooking pad thai' },
  { domain: 'music', prompt: 'แต่งเพลงประกอบหนังสั้น' },
  { domain: 'music', prompt: 'compose a 30-second jingle for a bakery brand' },
  { domain: 'game', prompt: 'ออกแบบเกม mobile แนว roguelike' },
  { domain: 'game', prompt: 'design a level for a 2D platformer' },
  { domain: 'marketing', prompt: 'ทำโฆษณา TikTok ขายขนมไทย' },
  { domain: 'marketing', prompt: 'write ad copy for a SaaS product launch' },
  { domain: 'education', prompt: 'ออกแบบหลักสูตรสอนภาษาจีน 12 สัปดาห์' },
  { domain: 'education', prompt: 'design a curriculum for a beginner JavaScript bootcamp' },
  { domain: 'business', prompt: 'ทำพิทช์เด็คสำหรับ Series A เกี่ยวกับ fintech' },
  { domain: 'business', prompt: 'draft a one-pager for the board on Q4 OKRs' },
  { domain: 'visual', prompt: 'design a logo for an oat-milk brand' },
  { domain: 'visual', prompt: 'ทำโปสเตอร์งาน hackathon' },
];

function makeUnderstanding(goal: string): SemanticTaskUnderstanding {
  // Stub STU — the deterministic creative-deliverable rule fires BEFORE
  // STU mapping. We just need a non-empty understanding object to satisfy
  // the function signature.
  return {
    rawGoal: goal,
    actionVerb: 'create',
    targetSymbol: undefined,
    taskDomain: 'general-reasoning',
    taskIntent: 'execute',
    toolRequirement: 'none',
    targetPaths: [],
    resolvedEntities: [],
    confidence: 0.5,
    sourceTier: 'rule',
    verifiedClaims: [],
    rejectedHypotheses: [],
  } as unknown as SemanticTaskUnderstanding;
}

function makeInput(goal: string): TaskInput {
  return {
    id: `audit-${Date.now()}`,
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 1000, maxRetries: 0 },
  };
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const t of PROMPTS) {
  const inferred = inferCreativeDomain(t.prompt);
  if (inferred !== t.domain) {
    failures.push(`[${t.domain}] inferCreativeDomain → ${inferred}: ${t.prompt}`);
    fail++;
    continue;
  }
  // Drive composeDeterministicCandidate; the creative-deliverable rule
  // fires when `matchesCreativeDeliverable(goal)` is true. We can't call
  // that helper directly (not exported), but we can detect the rule fired
  // by checking the deterministicCandidate.source field.
  const result = composeDeterministicCandidate(makeInput(t.prompt), makeUnderstanding(t.prompt));
  const fired = result.deterministicCandidate?.source === 'creative-deliverable-pattern';
  // Multi-agent regex MUST NOT match a casual prompt — that would route
  // through the collaboration runner unintentionally.
  const multiAgent = matchesMultiAgentDelegation(t.prompt);

  if (multiAgent) {
    failures.push(`[${t.domain}] casual prompt accidentally matches multi-agent regex: ${t.prompt}`);
    fail++;
    continue;
  }
  if (!fired) {
    failures.push(
      `[${t.domain}] CREATIVE_DELIVERABLE did NOT match — strategy=${result.strategy}, source=${result.deterministicCandidate?.source}: ${t.prompt}`,
    );
    fail++;
    continue;
  }
  if (result.strategy !== 'agentic-workflow') {
    failures.push(`[${t.domain}] rule fired but strategy=${result.strategy} (expected agentic-workflow): ${t.prompt}`);
    fail++;
    continue;
  }
  pass++;
  console.log(`✓ [${t.domain}] ${t.prompt.slice(0, 70)}`);
}

console.log('\n──── SUMMARY ────');
console.log(`PASS  ${pass}/${PROMPTS.length}`);
console.log(`FAIL  ${fail}/${PROMPTS.length}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
}
process.exit(fail > 0 ? 1 : 0);
