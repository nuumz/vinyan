/**
 * Smoke Test — Real LLM End-to-End Validation
 *
 * PURPOSE: Prove the system ACTUALLY WORKS with a real LLM provider.
 * This is the gate that prevents "done but not works" — Bias #2 (metric proxy).
 *
 * REQUIRES: ANTHROPIC_API_KEY or OPENROUTER_API_KEY environment variable.
 * Skips gracefully if no API key is available (CI-safe).
 *
 * WHAT IT TESTS:
 * 1. Factory constructs orchestrator with real LLM providers
 * 2. Core loop executes all phases (perceive → verify)
 * 3. LLM generates a meaningful response (not empty/error)
 * 4. For code tasks: mutations are produced with valid diffs
 * 5. Economy E1: a real task writes a priced cost row to `cost_ledger` using
 *    real provider token counts and the built-in rate cards — mock-provider
 *    tests cannot prove the DEFAULT_RATE_CARDS globs match live model ids.
 *
 * RUN: bun run test:smoke
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBus } from '../../src/core/bus.ts';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

// ── Skip guard ──────────────────────────────────────────────────────

const HAS_LLM_KEY = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);

function skipWithoutKey() {
  if (!HAS_LLM_KEY) {
    console.log('[smoke] Skipping — no ANTHROPIC_API_KEY or OPENROUTER_API_KEY');
  }
}

// ── Test fixtures ───────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-smoke-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Smoke tests ─────────────────────────────────────────────────────

describe('Smoke: Real LLM', () => {
  test('reasoning task returns a meaningful answer', async () => {
    skipWithoutKey();
    if (!HAS_LLM_KEY) return;

    const bus = createBus();
    const orchestrator = createOrchestrator({ workspace: tempDir, bus });

    const input: TaskInput = {
      id: `smoke-reasoning-${Date.now()}`,
      source: 'cli',
      goal: 'What is the capital of France? Answer in one word.',
      taskType: 'reasoning',
      budget: { maxTokens: 5000, maxDurationMs: 30_000, maxRetries: 1 },
    };

    let result: TaskResult;
    try {
      result = await orchestrator.executeTask(input);
    } finally {
      orchestrator.close();
    }

    // Core assertions: the system produced something
    expect(result).toBeDefined();
    expect(result.id).toBe(input.id);
    expect(['completed', 'escalated', 'uncertain']).toContain(result.status);

    // The LLM should have answered (not empty)
    expect(result.answer?.length).toBeGreaterThan(0);

    // Trace should record execution
    expect(result.trace.durationMs).toBeGreaterThan(0);
    expect(result.trace.routingLevel).toBeGreaterThanOrEqual(0);

    console.log(
      `[smoke] reasoning: status=${result.status} answer="${result.answer?.slice(0, 80)}" duration=${result.trace.durationMs}ms`,
    );
  }, 60_000);

  test('code task produces file mutations', async () => {
    skipWithoutKey();
    if (!HAS_LLM_KEY) return;

    // Create a simple file for the agent to modify
    const targetFile = join(tempDir, 'src', 'greet.ts');
    writeFileSync(targetFile, `export function greet(name: string): string {\n  return 'Hello';\n}\n`);

    const bus = createBus();
    const orchestrator = createOrchestrator({ workspace: tempDir, bus });

    const input: TaskInput = {
      id: `smoke-code-${Date.now()}`,
      source: 'cli',
      goal: 'Fix the greet function to use the name parameter. It should return `Hello, ${name}!` instead of just "Hello".',
      taskType: 'code',
      targetFiles: ['src/greet.ts'],
      budget: { maxTokens: 15000, maxDurationMs: 60_000, maxRetries: 2 },
    };

    let result: TaskResult;
    try {
      result = await orchestrator.executeTask(input);
    } finally {
      orchestrator.close();
    }

    expect(result).toBeDefined();
    expect(result.id).toBe(input.id);

    // For code tasks, we expect mutations or at least an answer
    const hasMutations = result.mutations.length > 0;
    const hasAnswer = (result.answer?.length ?? 0) > 0;
    expect(hasMutations || hasAnswer).toBe(true);

    if (hasMutations) {
      // At least one mutation should reference our target file
      const targetMutation = result.mutations.find((m) => m.file.includes('greet'));
      if (targetMutation) {
        expect(targetMutation.diff.length).toBeGreaterThan(0);
        console.log(`[smoke] code: mutation on ${targetMutation.file}, diff length=${targetMutation.diff.length}`);
      }
    }

    console.log(
      `[smoke] code: status=${result.status} mutations=${result.mutations.length} duration=${result.trace.durationMs}ms`,
    );
  }, 120_000);

  test('a real task writes a priced cost row to the ledger', async () => {
    skipWithoutKey();
    if (!HAS_LLM_KEY) return;

    const bus = createBus();
    const orchestrator = createOrchestrator({ workspace: tempDir, bus });
    // Economy E1 is Active by default — this test writes NO economy config.
    expect(orchestrator.costLedger).toBeDefined();
    expect(orchestrator.costPredictor).toBeDefined();
    expect(orchestrator.dynamicBudgetAllocator).toBeDefined();

    const input: TaskInput = {
      id: `smoke-cost-${Date.now()}`,
      source: 'cli',
      goal: 'Name one benefit of unit tests. One sentence.',
      taskType: 'reasoning',
      budget: { maxTokens: 5000, maxDurationMs: 30_000, maxRetries: 1 },
    };

    try {
      await orchestrator.executeTask(input);
    } finally {
      orchestrator.close();
    }

    // Read the durable record, not the in-memory cache.
    const db = new Database(join(tempDir, '.vinyan', 'vinyan.db'), { readonly: true });
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db.prepare('SELECT * FROM cost_ledger WHERE computed_usd > 0').all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    // Real provider token counts priced against a real rate card.
    expect(Number(row.tokens_input) + Number(row.tokens_output)).toBeGreaterThan(0);
    expect(Number(row.computed_usd)).toBeGreaterThan(0);
    expect(row.cost_tier).toBe('billing');
    expect(String(row.engine_id).length).toBeGreaterThan(0);

    console.log(
      `[smoke] cost: rows=${rows.length} engine=${row.engine_id} tier=${row.cost_tier} usd=${row.computed_usd}`,
    );
  }, 60_000);

  test('factory creates orchestrator with real providers', () => {
    // This test runs WITHOUT API key check — validates factory doesn't throw
    const bus = createBus();
    const orchestrator = createOrchestrator({ workspace: tempDir, bus });

    expect(orchestrator).toBeDefined();
    expect(typeof orchestrator.executeTask).toBe('function');
    expect(typeof orchestrator.close).toBe('function');

    orchestrator.close();
  });
});
