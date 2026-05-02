#!/usr/bin/env bun
/**
 * Experiment — Real LLM persona selector across goal domains.
 *
 * Calls `selectPersonasViaLLM` with the same registry but different goals
 * (code, prose, philosophy, food, healthcare) and prints the chosen
 * personas + rationale. Used to:
 *
 *   1. Verify the LLM picks domain-appropriate personas instead of always
 *      returning the alphabetical-fallback architect/author/developer.
 *   2. Tune the SYSTEM_PROMPT when the chosen personas look off — e.g.
 *      wrong domain match, lazy reuse of the same trio, integrator picked
 *      from primary pool, etc.
 *
 * Loads OPENROUTER_API_KEY from the project's `.env` (Bun auto-loads).
 *
 *   bun run scripts/experiment-persona-selector.ts
 */
import { LLMProviderRegistry } from '../src/orchestrator/llm/provider-registry.ts';
import { registerOpenRouterProviders } from '../src/orchestrator/llm/openrouter-provider.ts';
import { loadAgentRegistry } from '../src/orchestrator/agents/registry.ts';
import { selectPersonasViaLLM } from '../src/orchestrator/room/presets/llm-persona-selector.ts';
import type { CollaborationDirective } from '../src/orchestrator/intent/collaboration-parser.ts';

// Optional raw-response peek: set DEBUG_RAW=1 to wrap the fast provider's
// `generate` and print every raw LLM payload alongside the parsed result.
// Helps catch field-name drift (e.g. LLM returning `integrator` instead of
// `integratorPersonaId`) that the validator silently rejects.
const DEBUG_RAW = process.env.DEBUG_RAW === '1';

const TRIALS: Array<{ label: string; goal: string; directive: CollaborationDirective }> = [
  {
    label: 'CODE — auth module architecture',
    goal: 'How should we structure the authentication module for a large multi-tenant SaaS app? Design the module layout and the trade-offs.',
    directive: makeDirective(3, 'debate', 1),
  },
  {
    label: 'PROSE — bedtime story',
    goal: 'ช่วยเขียนนิทานก่อนนอนสำหรับเด็กอายุ 6 ขวบ ความยาว 2 บท เกี่ยวกับเด็กที่ค้นพบป่ามหัศจรรย์',
    directive: makeDirective(3, 'parallel-answer', 0),
  },
  {
    label: 'PHILOSOPHY — meaningful life',
    goal: 'What does it mean to live a meaningful life? Compare different philosophical traditions.',
    directive: makeDirective(3, 'debate', 1),
  },
  {
    label: 'COMPETITION — best programming language for ML',
    goal: 'Which is the best programming language for production machine-learning workloads? Compete and pick a winner.',
    directive: makeDirective(3, 'competition', 0),
  },
  {
    label: 'HEALTHCARE — diabetes management plan',
    goal: 'Draft a 30-day diabetes self-management plan for a newly diagnosed type-2 patient.',
    directive: makeDirective(3, 'comparison', 0),
  },
  {
    label: 'CODE+REVIEW — refactor strategy',
    goal: 'Review three possible refactor strategies for the legacy payment service and pick the safest one to ship next sprint.',
    directive: makeDirective(3, 'competition', 1),
  },
  {
    label: 'TH — generic Q&A (mirrors the screenshot prompt)',
    goal: 'แบ่ง sub-agent 3 ตัว แข่งกันถามตอบและเพิ่มกระบวนการโต้แย้งกันเองได้อีก 1 รอบ',
    directive: makeDirective(3, 'debate', 1),
  },
  {
    label: 'TH — recipe (cooking)',
    goal: 'อยากเรียนทำต้มยำกุ้งให้อร่อยที่สุด ขอวิธีแบบมือใหม่ พร้อมเหตุผลแต่ละขั้นตอน',
    directive: makeDirective(3, 'parallel-answer', 0),
  },
  {
    label: 'TH — career advice',
    goal: 'ผมอยากเปลี่ยนสายจาก backend dev ไป ML engineer ภายใน 1 ปี ควรเริ่มยังไง',
    directive: makeDirective(3, 'comparison', 1),
  },
];

function makeDirective(count: number, mode: CollaborationDirective['interactionMode'], rebuttalRounds: number): CollaborationDirective {
  return {
    requestedPrimaryParticipantCount: count,
    interactionMode: mode,
    rebuttalRounds,
    sharedDiscussion: rebuttalRounds > 0,
    reviewerPolicy: 'none',
    managerClarificationAllowed: true,
    emitCompetitionVerdict: mode === 'competition',
    source: 'pre-llm-parser',
    matchedFragments: { count: String(count) },
  };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('No OPENROUTER_API_KEY or ANTHROPIC_API_KEY in env. Aborting.');
    process.exit(1);
  }

  const llmRegistry = new LLMProviderRegistry();
  const registered = registerOpenRouterProviders(llmRegistry);

  if (DEBUG_RAW) {
    // Wrap the fast-tier provider so we can see every LLM raw payload.
    const fast = llmRegistry.selectByTier('fast');
    if (fast) {
      const original = fast.generate.bind(fast);
      fast.generate = async (req) => {
        const resp = await original(req);
        console.log(`\n[RAW LLM] ${fast.id}:`);
        console.log(resp.content);
        console.log('[/RAW]');
        return resp;
      };
    }
  }
  console.log(`Registered ${registered} OpenRouter provider(s).`);
  console.log(`Fast model: ${process.env.OPENROUTER_FAST_MODEL ?? '(default)'}`);
  console.log(`Balanced model: ${process.env.OPENROUTER_BALANCED_MODEL ?? '(default)'}`);
  console.log('');

  const agentRegistry = loadAgentRegistry(process.cwd());
  const roster = agentRegistry.listAgents();
  console.log(`Roster (${roster.length} personas):`);
  for (const a of roster) {
    console.log(`  - ${a.id} (role=${a.role ?? '(none)'}): ${a.description ?? '(no description)'}`);
  }
  console.log('');

  for (const trial of TRIALS) {
    console.log('────────────────────────────────────────────────────────────');
    console.log(`▶ ${trial.label}`);
    console.log(`  goal:  ${trial.goal}`);
    console.log(`  mode:  ${trial.directive.interactionMode} | rounds=${trial.directive.rebuttalRounds + 1} | count=${trial.directive.requestedPrimaryParticipantCount}`);
    const t0 = Date.now();
    let result;
    try {
      result = await selectPersonasViaLLM({
        goal: trial.goal,
        directive: trial.directive,
        registry: agentRegistry,
        llmRegistry,
      });
    } catch (err) {
      console.log(`  ✗ THREW: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const dt = Date.now() - t0;
    if (!result) {
      console.log(`  ✗ FALLBACK (selector returned null after ${dt}ms)`);
      continue;
    }
    console.log(`  ✓ primaries:  ${result.primaryIds.join(', ')}`);
    console.log(`  ✓ integrator: ${result.integratorId ?? '(default)'}`);
    if (result.rationale) console.log(`  ✓ rationale:  ${result.rationale}`);
    console.log(`  ⏱ ${dt}ms · attempts=${result.attempts}`);
  }
  console.log('────────────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
