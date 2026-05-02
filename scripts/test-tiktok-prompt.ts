#!/usr/bin/env bun
/**
 * Quick probe — what happens to a casual real-world prompt
 *   "ช่วยทำคอนเท้นลง tiktok"
 * across the multi-agent intent layer + persona selector.
 *
 * Tests multiple prompt shapes to map out where the multi-agent path
 * fires and what personas the selector picks for TikTok-content work.
 */
import { loadAgentRegistry } from '../src/orchestrator/agents/registry.ts';
import {
  classifyCollaborationIntent,
  parseCollaborationDirective,
} from '../src/orchestrator/intent/collaboration-parser.ts';
import { matchesMultiAgentDelegation } from '../src/orchestrator/intent/strategy.ts';
import { registerOpenRouterProviders } from '../src/orchestrator/llm/openrouter-provider.ts';
import { LLMProviderRegistry } from '../src/orchestrator/llm/provider-registry.ts';
import { selectPersonasViaLLM } from '../src/orchestrator/room/presets/llm-persona-selector.ts';

const PROMPTS = [
  // The user's exact prompt — no multi-agent signal at all.
  'ช่วยทำคอนเท้นลง tiktok',
  // Slightly more specific — still no count, no debate signal.
  'ช่วยทำ content lง tiktok เกี่ยวกับร้านกาแฟ',
  // Adds a count → triggers multi-agent path.
  'แบ่ง 3 agent ช่วยทำคอนเท้นลง tiktok',
  // Count + competition signal.
  'แบ่ง 3 agent แข่งกันทำคอนเท้นลง tiktok',
  // Count + parallel-answer (3 distinct ideas).
  'แบ่ง 3 agent ช่วยกันคิดคอนเท้น tiktok 3 แบบที่ต่างกัน',
  // English variant for comparison.
  'have 3 agents brainstorm TikTok content for a small bakery',
];

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('PHASE 1: Multi-agent intent gating');
  console.log('═══════════════════════════════════════════════════════\n');

  for (const goal of PROMPTS) {
    const matches = matchesMultiAgentDelegation(goal);
    const intent = classifyCollaborationIntent(goal);
    const directive = parseCollaborationDirective(goal);
    console.log(`Goal: ${goal}`);
    console.log(`  multi-agent regex match : ${matches}`);
    console.log(`  intent classification   : ${intent}`);
    console.log(`  parsed directive        : ${
      directive
        ? `count=${directive.requestedPrimaryParticipantCount}, mode=${directive.interactionMode}, rounds=${directive.rebuttalRounds}`
        : 'null (no multi-agent path)'
    }`);
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('PHASE 2: Persona selection for prompts that fire the path');
  console.log('═══════════════════════════════════════════════════════\n');

  if (!process.env.OPENROUTER_API_KEY) {
    console.log('No API key — skipping LLM probe');
    return;
  }
  const llmRegistry = new LLMProviderRegistry();
  registerOpenRouterProviders(llmRegistry);
  const agentRegistry = loadAgentRegistry(process.cwd());

  for (const goal of PROMPTS) {
    const directive = parseCollaborationDirective(goal);
    if (!directive) continue;
    console.log(`Goal: ${goal}`);
    console.log(`  count=${directive.requestedPrimaryParticipantCount} mode=${directive.interactionMode}`);
    const t0 = Date.now();
    const result = await selectPersonasViaLLM({
      goal,
      directive,
      registry: agentRegistry,
      llmRegistry,
    });
    const dt = Date.now() - t0;
    if (!result) {
      console.log(`  ✗ null (selector failed) ${dt}ms`);
    } else {
      console.log(`  primaries: [${result.primaryIds.join(', ')}]`);
      console.log(`  integrator: ${result.integratorId ?? '(parallel-answer — no integrator)'}`);
      if (result.rationale) console.log(`  rationale: ${result.rationale}`);
      console.log(`  ${dt}ms · attempts=${result.attempts}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
