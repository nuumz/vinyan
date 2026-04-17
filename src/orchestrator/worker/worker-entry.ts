/**
 * Worker Entry — child process entry point for L1+ task execution.
 *
 * Two modes:
 *   Single-shot (default): Read stdin → process → write stdout → exit.
 *   Warm (--warm flag):    Setup once → loop reading JSON lines → process each → stay alive.
 *
 * Does NOT execute tool calls — the orchestrator handles tool execution
 * after receiving the worker output.
 *
 * Follows oracle/runner.ts IPC pattern: JSON stdin → JSON stdout.
 * Source of truth: spec/tdd.md §16.3 (Worker lifecycle)
 */

import type { z } from 'zod';
import { assemblePrompt } from '../llm/prompt-assembler.ts';
import { LLMProviderRegistry } from '../llm/provider-registry.ts';
import { WorkerInputSchema, WorkerOutputSchema } from '../protocol.ts';

// ── Shared logic ──────────────────────────────────────────────────────

/** Set up LLM provider registry from env vars (proxy or direct API keys). */
async function setupRegistry(): Promise<LLMProviderRegistry> {
  const registry = new LLMProviderRegistry();
  const proxySocket = process.env.VINYAN_LLM_PROXY_SOCKET;

  if (proxySocket) {
    const { createProxyProvider } = await import('../llm/llm-proxy.ts');
    registry.register(createProxyProvider(proxySocket, 'fast'));
    registry.register(createProxyProvider(proxySocket, 'balanced'));
    registry.register(createProxyProvider(proxySocket, 'powerful'));
  } else {
    try {
      const { registerOpenRouterProviders } = await import('../llm/openrouter-provider.ts');
      registerOpenRouterProviders(registry);
    } catch {
      // OpenRouter not available
    }

    if (registry.listProviders().length === 0) {
      try {
        const { createAnthropicProvider } = await import('../llm/anthropic-provider.ts');
        const provider = createAnthropicProvider();
        if (provider) registry.register(provider);
      } catch {
        // Anthropic SDK not available
      }
    }
  }

  return registry;
}

/** Process a single task: select provider → generate → parse → return output. */
async function processTask(
  input: z.infer<typeof WorkerInputSchema>,
  registry: LLMProviderRegistry,
): Promise<z.infer<typeof WorkerOutputSchema>> {
  // PH4.4: workerId from input (warm mode) or env var (cold mode), fallback to tier-based
  const workerId = input.workerId ?? process.env.VINYAN_WORKER_ID;
  const provider = workerId
    ? (registry.selectById(workerId) ?? registry.selectForRoutingLevel(input.routingLevel))
    : registry.selectForRoutingLevel(input.routingLevel);

  if (!provider) {
    return {
      taskId: input.taskId,
      proposedMutations: [],
      proposedToolCalls: [],
      uncertainties: [`No LLM provider available for routing level ${input.routingLevel}`],
      tokensConsumed: 0,
      durationMs: 0,
    };
  }

  const { systemPrompt, userPrompt } = assemblePrompt(
    input.goal,
    input.perception,
    input.workingMemory,
    input.plan,
    input.taskType ?? 'code',
    input.instructions ?? null, // Phase 7a: M1-M4 hierarchy resolved in-process, shipped via WorkerInput
    input.understanding, // Gap 9A: TaskUnderstanding for enriched prompt
    input.routingLevel, // R2 (§5): gate tool descriptions out of L0-L1 prompts
    undefined, // conversationHistory (structured subprocess path is single-shot)
    input.environment ?? null, // Phase 7a: OS/cwd/git snapshot
  );

  const startTime = performance.now();
  // Temperature: reasoning tasks use 0.3 for variance control, code tasks use 0.2 for precision
  const temperature = (input.taskType ?? 'code') === 'reasoning' ? 0.3 : 0.2;
  const llmRequest = {
    systemPrompt,
    userPrompt,
    maxTokens: input.budget.maxTokens,
    temperature,
  };
  const response =
    input.stream && provider.generateStream
      ? await provider.generateStream(llmRequest, ({ text }) => {
          // Emit delta line to stdout; parent worker-pool pumps these to bus.
          // Newline is the framing delimiter — `text` may contain any chars
          // including newlines, so we JSON-encode the whole envelope.
          try {
            process.stdout.write(`${JSON.stringify({ type: 'delta', taskId: input.taskId, text })}\n`);
          } catch {
            /* broken pipe — parent gone; ignore */
          }
        })
      : await provider.generate(llmRequest);
  const durationMs = Math.round(performance.now() - startTime);
  const tokens = response.tokensUsed.input + response.tokensUsed.output;

  try {
    const parsed = JSON.parse(extractJSON(response.content));
    return {
      taskId: input.taskId,
      proposedMutations: parsed.proposedMutations ?? [],
      proposedToolCalls: parsed.proposedToolCalls ?? response.toolCalls ?? [],
      uncertainties: parsed.uncertainties ?? [],
      tokensConsumed: tokens,
      durationMs,
    };
  } catch {
    return {
      taskId: input.taskId,
      proposedMutations: [],
      proposedToolCalls: [],
      uncertainties: [],
      tokensConsumed: tokens,
      durationMs,
      ...(response.content?.trim() ? { proposedContent: response.content } : {}),
    };
  }
}

// ── Single-shot mode (default) ────────────────────────────────────────

async function main() {
  const rawChunks: Uint8Array[] = [];
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rawChunks.push(value);
  }

  const totalLength = rawChunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of rawChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const rawInput = new TextDecoder().decode(combined);
  const input = WorkerInputSchema.parse(JSON.parse(rawInput));

  const registry = await setupRegistry();
  const output = await processTask(input, registry);
  writeOutput(output);
}

// ── Warm mode (--warm flag) ───────────────────────────────────────────

async function warmMain() {
  const registry = await setupRegistry();
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Signal readiness
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

  while (true) {
    const line = await readOneLine();
    if (line === null) break; // stdin closed → exit

    try {
      const input = WorkerInputSchema.parse(JSON.parse(line));
      const output = await processTask(input, registry);
      writeOutput(output);
    } catch (err) {
      writeOutput({
        taskId: 'unknown',
        proposedMutations: [],
        proposedToolCalls: [],
        uncertainties: [`Warm worker error: ${err instanceof Error ? err.message : String(err)}`],
        tokensConsumed: 0,
        durationMs: 0,
      });
    }
  }

  async function readOneLine(): Promise<string | null> {
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) return line;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) return buffer.trim() || null;
      buffer += decoder.decode(value, { stream: true });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function writeOutput(output: unknown): void {
  const validated = WorkerOutputSchema.parse(output);
  process.stdout.write(`${JSON.stringify(validated)}\n`);
}

/** Extract JSON from LLM response that may be wrapped in markdown fences or leading text. */
function extractJSON(content: string): string {
  let str = content.trim();
  const fenceMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    str = fenceMatch[1]?.trim() ?? str;
  }
  if (!str.startsWith('{')) {
    const firstBrace = str.indexOf('{');
    const lastBrace = str.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      str = str.slice(firstBrace, lastBrace + 1);
    }
  }
  return str;
}

// ── Entry point ──────────────────────────────────────────────────────

const isWarm = process.argv.includes('--warm');

(isWarm ? warmMain() : main()).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
