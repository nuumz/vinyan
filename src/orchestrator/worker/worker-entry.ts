/**
 * Worker Entry — child process entry point for L1+ task execution.
 *
 * Reads WorkerInput from stdin, selects LLM provider, generates response,
 * writes WorkerOutput to stdout. Does NOT execute tool calls — the
 * orchestrator handles tool execution after receiving the worker output.
 *
 * Follows oracle/runner.ts IPC pattern: JSON stdin → JSON stdout.
 * Source of truth: vinyan-tdd.md §16.3 (Worker lifecycle)
 */
import { WorkerInputSchema, WorkerOutputSchema } from "../protocol.ts";
import { LLMProviderRegistry } from "../llm/provider-registry.ts";
import { assemblePrompt } from "../llm/prompt-assembler.ts";

async function main() {
  const rawChunks: Uint8Array[] = [];
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rawChunks.push(value);
  }

  // Concatenate and decode once to avoid corrupting multi-byte UTF-8
  const totalLength = rawChunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of rawChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const rawInput = new TextDecoder().decode(combined);
  const input = WorkerInputSchema.parse(JSON.parse(rawInput));

  // Set up provider registry — same priority as factory.ts (OpenRouter first, Anthropic fallback)
  const registry = new LLMProviderRegistry();

  try {
    const { registerOpenRouterProviders } = await import("../llm/openrouter-provider.ts");
    registerOpenRouterProviders(registry);
  } catch {
    // OpenRouter not available
  }

  if (registry.listProviders().length === 0) {
    try {
      const { createAnthropicProvider } = await import("../llm/anthropic-provider.ts");
      const provider = createAnthropicProvider();
      if (provider) registry.register(provider);
    } catch {
      // Anthropic SDK not available
    }
  }

  const provider = registry.selectForRoutingLevel(input.routingLevel);

  if (!provider) {
    writeOutput({
      taskId: input.taskId,
      proposedMutations: [],
      proposedToolCalls: [],
      uncertainties: [`No LLM provider available for routing level ${input.routingLevel}`],
      tokensConsumed: 0,
      duration_ms: 0,
    });
    return;
  }

  const { systemPrompt, userPrompt } = assemblePrompt(
    input.goal,
    input.perception,
    input.workingMemory,
    input.plan,
  );

  const startTime = performance.now();

  const response = await provider.generate({
    systemPrompt,
    userPrompt,
    maxTokens: input.budget.maxTokens,
  });

  const duration_ms = Math.round(performance.now() - startTime);
  const tokens = response.tokensUsed.input + response.tokensUsed.output;

  let output;
  try {
    const parsed = JSON.parse(response.content);
    output = {
      taskId: input.taskId,
      proposedMutations: parsed.proposedMutations ?? [],
      proposedToolCalls: parsed.proposedToolCalls ?? response.toolCalls ?? [],
      uncertainties: parsed.uncertainties ?? [],
      tokensConsumed: tokens,
      duration_ms,
    };
  } catch {
    output = {
      taskId: input.taskId,
      proposedMutations: [],
      proposedToolCalls: [],
      uncertainties: [],
      tokensConsumed: tokens,
      duration_ms,
    };
  }

  writeOutput(output);
}

function writeOutput(output: unknown): void {
  const validated = WorkerOutputSchema.parse(output);
  process.stdout.write(JSON.stringify(validated) + "\n");
}

main().catch(err => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
