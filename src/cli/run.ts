/**
 * CLI Agent Mode — `vinyan run "task" --file src/foo.ts`
 *
 * Syntax: vinyan run "task description" --file src/foo.ts --budget 50000 [--retries 3] [--timeout 60000]
 * Output: TaskResult as JSON to stdout, progress to stderr
 * Exit:   0=completed, 1=failed, 2=escalated
 *
 * CLI is a bus consumer — it observes the core loop via event listeners
 * without modifying execution behavior (A3 compliance).
 *
 * Source of truth: vinyan-tdd.md §16 (Core Loop), §1A.8 (CLI)
 */
import { createOrchestrator } from "../orchestrator/factory.ts";
import { createBus } from "../core/bus.ts";
import { attachCLIProgressListener } from "../bus/cli-progress-listener.ts";
import { attachTraceListener } from "../bus/trace-listener.ts";
import type { TaskInput, TaskResult } from "../orchestrator/types.ts";
import type { TraceTelemetry } from "../bus/trace-listener.ts";

export async function runAgentTask(argv: string[]): Promise<void> {
  // Parse arguments
  const goalIndex = argv.indexOf("run") + 1;
  const goal = argv[goalIndex];

  if (!goal || goal.startsWith("--")) {
    console.error('Usage: vinyan run "task description" [--file path] [--budget tokens] [--retries n] [--timeout ms]');
    console.error("Flags: --verbose  Show oracle verdict details");
    console.error("       --quiet    Suppress progress output");
    console.error("       --summary  Print human-friendly summary to stdout instead of JSON");
    process.exit(2);
  }

  const files = parseArrayFlag(argv, "--file");
  const budget = parseInt(parseSingleFlag(argv, "--budget") ?? "50000", 10);
  const retries = parseInt(parseSingleFlag(argv, "--retries") ?? "3", 10);
  const timeout = parseInt(parseSingleFlag(argv, "--timeout") ?? "60000", 10);
  const workspace = parseSingleFlag(argv, "--workspace") ?? process.cwd();
  const quiet = argv.includes("--quiet");
  const verbose = argv.includes("--verbose");
  const summaryMode = argv.includes("--summary");

  const input: TaskInput = {
    id: `task-${Date.now().toString(36)}`,
    source: "cli",
    goal,
    targetFiles: files.length > 0 ? files : undefined,
    budget: {
      maxTokens: budget,
      maxDurationMs: timeout,
      maxRetries: retries,
    },
  };

  // Create bus and attach listeners BEFORE creating orchestrator
  const bus = createBus();

  let detachProgress: (() => void) | undefined;
  if (!quiet) {
    detachProgress = attachCLIProgressListener(bus, {
      verbose,
      color: process.stderr.isTTY ?? false,
    });
  }

  const traceListenerHandle = attachTraceListener(bus);
  const orchestrator = createOrchestrator({ workspace, bus });

  try {
    const result = await orchestrator.executeTask(input);
    const metrics = traceListenerHandle.getMetrics();

    // Output
    if (summaryMode) {
      printSummary(result, metrics, process.stdout);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    // Summary to stderr (unless quiet)
    if (!quiet && !summaryMode) {
      printSummary(result, metrics, process.stderr);
    }

    // Cleanup
    detachProgress?.();
    orchestrator.close();

    switch (result.status) {
      case "completed":
        process.exit(0);
        break;
      case "failed":
        process.exit(1);
        break;
      case "escalated":
        process.exit(2);
        break;
    }
  } catch (err) {
    detachProgress?.();
    orchestrator.close();
    console.error(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function printSummary(
  result: TaskResult,
  metrics: TraceTelemetry,
  output: NodeJS.WritableStream,
): void {
  const status =
    result.status === "completed" ? "OK" :
    result.status === "escalated" ? "ESCALATED" : "FAILED";

  const qs = result.qualityScore
    ? ` quality=${result.qualityScore.composite.toFixed(2)} (${result.qualityScore.dimensions_available}D)`
    : "";

  output.write(`\n[vinyan] ${status} | ${metrics.totalTraces} attempt(s) | ${result.trace.duration_ms}ms${qs}\n`);

  if (result.escalationReason) {
    output.write(`[vinyan] Escalation: ${result.escalationReason}\n`);
  }

  if (result.mutations.length > 0) {
    output.write(`[vinyan] Files modified: ${result.mutations.map(m => m.file).join(", ")}\n`);
  }
}

function parseSingleFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function parseArrayFlag(argv: string[], flag: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) {
      results.push(argv[i + 1]!);
      i++; // skip value
    }
  }
  return results;
}
