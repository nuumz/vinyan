#!/usr/bin/env bun
/**
 * Full E2E trace — what Vinyan ACTUALLY does with the casual prompt
 *   "ช่วยทำคอนเท้นลง tiktok"
 *
 * Initializes the real orchestrator (with real LLM provider), submits the
 * task, captures every bus event, and prints a clean step-by-step trace
 * so we can see:
 *   - What strategy the intent resolver picks
 *   - What plan the workflow planner generates
 *   - What each step actually executes
 *   - The final answer
 *
 * Stops short of touching the user's repo — runs in a temp workspace.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../src/core/bus.ts';
import { createOrchestrator } from '../src/orchestrator/factory.ts';
import type { TaskInput } from '../src/orchestrator/types.ts';

interface CapturedEvent {
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('Need OPENROUTER_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'vinyan-trace-'));
  console.log(`Workspace: ${tempDir}`);

  const bus = createBus();
  const events: CapturedEvent[] = [];
  const start = Date.now();

  // Capture the events that matter for understanding the agent's plan +
  // execution. Skip noisy/internal events (capability tokens, hash bus
  // chatter, etc.) so the trace stays readable.
  const tracked = [
    'intent:resolved',
    'comprehension:completed',
    'workflow:plan_created',
    'workflow:plan_ready',
    'workflow:plan_approved',
    'workflow:plan_rejected',
    'workflow:persona_selection_completed',
    'workflow:step_start',
    'workflow:step_complete',
    'workflow:step_fallback',
    'workflow:complete',
    'workflow:delegate_dispatched',
    'workflow:delegate_completed',
    'workflow:human_input_needed',
    'agent:clarification_requested',
    'task:phase_start',
    'task:phase_complete',
    'task:complete',
    // Phase A specialist-format observability
    'specialist:fallback_used',
    'specialist:adapter_failed',
    'specialist:format_skipped',
  ] as const;
  for (const t of tracked) {
    bus.on(t as never, (payload: unknown) => {
      events.push({
        type: t,
        ts: Date.now() - start,
        payload: (payload as Record<string, unknown>) ?? {},
      });
    });
  }

  const orchestrator = createOrchestrator({ workspace: tempDir, bus });

  const goal = process.env.GOAL ?? 'ช่วยทำคอนเท้นลง tiktok';
  // Optionally inject a prior session turn so the creative-clarification
  // gate skips (it only fires on fresh sessions). Set SKIP_CLARIFY=1 to
  // simulate "user has already answered" and exercise Phase A + D below.
  const skipClarify = process.env.SKIP_CLARIFY === '1';
  let sessionId: string | undefined;
  if (skipClarify) {
    const sessionMgr = (
      orchestrator as unknown as {
        deps?: { sessionManager?: { createSession?: (s: { id: string }) => unknown; appendTurn?: (...a: unknown[]) => unknown } };
      }
    ).deps?.sessionManager;
    sessionId = `trace-session-${Date.now()}`;
    if (sessionMgr?.createSession && sessionMgr.appendTurn) {
      sessionMgr.createSession({ id: sessionId });
      sessionMgr.appendTurn(sessionId, {
        role: 'user',
        content: 'previous prompt to mark session as having history',
        ts: Date.now() - 60_000,
      });
      sessionMgr.appendTurn(sessionId, {
        role: 'assistant',
        content: 'previous assistant reply',
        ts: Date.now() - 30_000,
      });
    } else {
      sessionId = undefined; // session manager not wired — leave fresh
    }
  }
  // SKIP_CLARIFY=1 packs the user's prior answers into the orchestrator's
  // CLARIFICATION_BATCH constraint convention so the gate at
  // `creative-clarification-gate.ts:54` skips. This simulates Turn 2 of
  // a real session — the user has already picked options and now we want
  // to see Phase A (specialist format) + Phase D (persona overlay) execute.
  const constraints = skipClarify
    ? [
        `CLARIFICATION_BATCH:${JSON.stringify({
          version: 1,
          previousQuestions: [
            { id: 'genre', prompt: 'genre?' },
            { id: 'audience', prompt: 'audience?' },
            { id: 'tone', prompt: 'tone?' },
            { id: 'length', prompt: 'length?' },
            { id: 'target-platform', prompt: 'platform?' },
          ],
          userReply:
            'comedy lifestyle, teen audience, humorous tone, 30 second clip, TikTok and IG Reels',
        })}`,
      ]
    : undefined;
  const input: TaskInput = {
    id: `trace-tiktok-${Date.now()}`,
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 60_000, maxDurationMs: 180_000, maxRetries: 1 },
    ...(sessionId ? { sessionId } : {}),
    ...(constraints ? { constraints } : {}),
  };

  console.log(`Goal: ${input.goal}`);
  console.log('Submitting task...\n');

  let result;
  try {
    result = await orchestrator.executeTask(input);
  } finally {
    orchestrator.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  printTrace(events, result, Date.now() - start);
}

function printTrace(
  events: CapturedEvent[],
  result: { id: string; status: string; answer?: string; trace?: { tokensConsumed?: number } },
  durationMs: number,
): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                       PIPELINE TRACE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // 1. Intent resolution
  const intent = events.find((e) => e.type === 'intent:resolved');
  if (intent) {
    const p = intent.payload;
    console.log(`[${intent.ts}ms] INTENT RESOLVED`);
    console.log(`  strategy:    ${p.strategy ?? '(unknown)'}`);
    console.log(`  confidence:  ${p.confidence ?? '?'}`);
    console.log(`  source:      ${p.reasoningSource ?? '?'}`);
    if (p.reasoning) console.log(`  reasoning:   ${String(p.reasoning).slice(0, 200)}${String(p.reasoning).length > 200 ? '…' : ''}`);
    console.log('');
  }

  // 2. Comprehension
  const comp = events.find((e) => e.type === 'comprehension:completed');
  if (comp) {
    const p = comp.payload;
    console.log(`[${comp.ts}ms] COMPREHENSION`);
    if (p.taskDomain) console.log(`  domain:        ${p.taskDomain}`);
    if (p.taskIntent) console.log(`  intent:        ${p.taskIntent}`);
    if (p.toolRequirement) console.log(`  tool need:     ${p.toolRequirement}`);
    console.log('');
  }

  // 3. Persona selection
  const personaSel = events.find((e) => e.type === 'workflow:persona_selection_completed');
  if (personaSel) {
    const p = personaSel.payload;
    console.log(`[${personaSel.ts}ms] PERSONA SELECTION`);
    console.log(`  origin:      ${p.origin ?? '?'}`);
    if (Array.isArray(p.primaryIds)) console.log(`  primaries:   [${p.primaryIds.join(', ')}]`);
    if (p.integratorId) console.log(`  integrator:  ${p.integratorId}`);
    if (p.rationale) console.log(`  rationale:   ${p.rationale}`);
    console.log('');
  } else {
    console.log('  (no persona selection event — not on multi-agent path)\n');
  }

  // 4. Plan
  const plan = events.find((e) => e.type === 'workflow:plan_created');
  if (plan) {
    const p = plan.payload;
    console.log(`[${plan.ts}ms] WORKFLOW PLAN CREATED`);
    console.log(`  origin:    ${p.origin ?? '?'}  attempts: ${p.attempts ?? '?'}`);
    if (Array.isArray(p.steps)) {
      console.log(`  steps (${p.steps.length}):`);
      for (const s of p.steps as Array<Record<string, unknown>>) {
        console.log(`    [${s.id}] strategy=${s.strategy}  deps=${JSON.stringify(s.dependencies ?? [])}`);
        console.log(`        ${String(s.description ?? '').slice(0, 200)}`);
      }
    }
    console.log('');
  }

  // 5. Plan approval
  const approval = events.find((e) => e.type === 'workflow:plan_approved' || e.type === 'workflow:plan_rejected');
  if (approval) {
    console.log(`[${approval.ts}ms] PLAN ${approval.type === 'workflow:plan_approved' ? 'APPROVED' : 'REJECTED'}`);
    if (approval.payload.auto) console.log('  (auto-approved)');
    console.log('');
  }

  // 5b. Phase A specialist format observability
  const specialistEvents = events.filter((e) => e.type.startsWith('specialist:'));
  if (specialistEvents.length > 0) {
    console.log('SPECIALIST EVENTS');
    console.log('─────────────────');
    for (const e of specialistEvents) {
      console.log(`[${e.ts}ms] ${e.type}  payload=${JSON.stringify(e.payload).slice(0, 200)}`);
    }
    console.log('');
  }

  // 6. Step execution
  const stepStarts = events.filter((e) => e.type === 'workflow:step_start');
  const stepCompletes = events.filter((e) => e.type === 'workflow:step_complete');
  const delegateDispatched = events.filter((e) => e.type === 'workflow:delegate_dispatched');
  const delegateCompleted = events.filter((e) => e.type === 'workflow:delegate_completed');
  console.log('STEP EXECUTION');
  console.log('───────────────');
  for (const e of [...stepStarts, ...stepCompletes, ...delegateDispatched, ...delegateCompleted].sort(
    (a, b) => a.ts - b.ts,
  )) {
    const p = e.payload;
    if (e.type === 'workflow:step_start') {
      console.log(`[${e.ts}ms] ▶ STEP ${p.stepId} (${p.strategy}) start`);
    } else if (e.type === 'workflow:step_complete') {
      const status = p.status ?? '?';
      const symbol = status === 'completed' ? '✓' : status === 'failed' ? '✗' : '◐';
      console.log(`[${e.ts}ms] ${symbol} STEP ${p.stepId} ${status} ${p.durationMs ?? '?'}ms ${p.tokensConsumed ?? 0}tok`);
    } else if (e.type === 'workflow:delegate_dispatched') {
      console.log(`[${e.ts}ms]   → delegate ${p.stepId} as ${p.agentId ?? '(default)'}`);
    } else if (e.type === 'workflow:delegate_completed') {
      const status = p.status ?? '?';
      console.log(`[${e.ts}ms]   ← delegate ${p.stepId} ${status} (${String(p.outputPreview ?? '').slice(0, 100)}…)`);
    }
  }
  console.log('');

  const human = events.filter((e) => e.type === 'workflow:human_input_needed');
  if (human.length > 0) {
    console.log('HUMAN INPUT REQUESTED');
    for (const e of human) {
      console.log(`[${e.ts}ms] ❓ ${e.payload.question ?? '(no question)'}`);
    }
    console.log('');
  }

  const clarifications = events.filter((e) => e.type === 'agent:clarification_requested');
  if (clarifications.length > 0) {
    console.log('CLARIFICATION REQUESTED');
    console.log('───────────────────────');
    for (const e of clarifications) {
      console.log(`[${e.ts}ms] source=${e.payload.source ?? '?'}`);
      const questions = (e.payload.questions ?? []) as string[];
      for (const q of questions) console.log(`  • ${q}`);
      const struct = e.payload.structuredQuestions as
        | Array<{
            id?: string;
            prompt?: string;
            questionRationale?: string;
            options?: Array<{ id?: string; label?: string; suggestedDefault?: boolean; rationale?: string; trendingHint?: string }>;
          }>
        | undefined;
      if (struct) {
        for (const sq of struct) {
          console.log(`  ${sq.id ?? '?'}: ${sq.prompt ?? ''}`);
          if (sq.questionRationale) console.log(`     ☆ ${sq.questionRationale}`);
          for (const o of sq.options ?? []) {
            const star = o.suggestedDefault ? ' ★' : '';
            const trend = o.trendingHint ? ` [${o.trendingHint}]` : '';
            console.log(`     ${o.id ?? '?'}: ${o.label ?? ''}${star}${trend}`);
            if (o.rationale) console.log(`        ↳ ${o.rationale}`);
          }
        }
      }
    }
    console.log('');
  }

  // 7. Final result
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                       FINAL RESULT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`status:   ${result.status}`);
  console.log(`duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`tokens:   ${result.trace?.tokensConsumed ?? '?'}`);
  console.log('');
  console.log('Answer:');
  console.log(result.answer ?? '(empty)');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
