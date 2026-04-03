/**
 * CLI Agent Mode — `vinyan run "task" --file src/foo.ts`
 *
 * Syntax: vinyan run "task description" --file src/foo.ts --budget 50000 [--retries 3] [--timeout 60000]
 * Output: TaskResult as JSON to stdout, progress to stderr
 * Exit:   0=completed, 1=failed, 2=escalated, 3=uncertain
 *
 * CLI is a bus consumer — it observes the core loop via event listeners
 * without modifying execution behavior (A3 compliance).
 *
 * Source of truth: spec/tdd.md §16 (Core Loop), §1A.8 (CLI)
 */

import { attachCLIProgressListener } from '../bus/cli-progress-listener.ts';
import type { TraceTelemetry } from '../bus/trace-listener.ts';
import { attachTraceListener } from '../bus/trace-listener.ts';
import { createBus } from '../core/bus.ts';
import { createOrchestrator } from '../orchestrator/factory.ts';
import type { TaskInput, TaskResult } from '../orchestrator/types.ts';

export async function runAgentTask(argv: string[]): Promise<void> {
  // Parse arguments
  const goalIndex = argv.indexOf('run') + 1;
  const goal = argv[goalIndex];

  if (!goal || goal.startsWith('--')) {
    console.error('Usage: vinyan run "task description" [--file path] [--budget tokens] [--retries n] [--timeout ms]');
    console.error('Flags: --verbose  Show oracle verdict details');
    console.error('       --quiet    Suppress progress output');
    console.error('       --summary  Print human-friendly summary to stdout instead of JSON');
    process.exit(2);
  }

  const files = parseArrayFlag(argv, '--file');
  const budgetRaw = parseInt(parseSingleFlag(argv, '--budget') ?? '50000', 10);
  const retriesRaw = parseInt(parseSingleFlag(argv, '--retries') ?? '3', 10);
  const timeoutRaw = parseInt(parseSingleFlag(argv, '--timeout') ?? '60000', 10);

  // Validate numeric arguments
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 50_000;
  const retries = Number.isFinite(retriesRaw) && retriesRaw > 0 ? retriesRaw : 3;
  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 60_000;

  const workspace = parseSingleFlag(argv, '--workspace') ?? process.cwd();
  const quiet = argv.includes('--quiet');
  const verbose = argv.includes('--verbose');
  const summaryMode = argv.includes('--summary');

  const input: TaskInput = {
    id: `task-${Date.now().toString(36)}`,
    source: 'cli',
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
  const orchestrator = createOrchestrator({ workspace, bus, llmProxy: true });

  // Graceful shutdown on signals
  const shutdown = () => {
    detachProgress?.();
    orchestrator.close();
    process.exit(130);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

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
      case 'completed':
        process.exit(0);
        break;
      case 'failed':
        process.exit(1);
        break;
      case 'escalated':
        process.exit(2);
        break;
      case 'uncertain':
        process.exit(3);
        break;
    }
  } catch (err) {
    detachProgress?.();
    orchestrator.close();
    console.error(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function printSummary(result: TaskResult, metrics: TraceTelemetry, output: NodeJS.WritableStream): void {
  const status =
    result.status === 'completed'
      ? 'OK'
      : result.status === 'escalated'
        ? 'ESCALATED'
        : result.status === 'uncertain'
          ? 'UNCERTAIN'
          : 'FAILED';

  const qs = result.qualityScore && !Number.isNaN(result.qualityScore.composite)
    ? ` quality=${result.qualityScore.composite.toFixed(2)} (${result.qualityScore.dimensionsAvailable}D)`
    : '';

  output.write(`\n[vinyan] ${status} | ${metrics.totalTraces} attempt(s) | ${result.trace.durationMs}ms${qs}\n`);

  if (result.answer) {
    output.write(`\n${result.answer}\n`);
  }

  if (result.escalationReason) {
    output.write(`[vinyan] Escalation: ${result.escalationReason}\n`);
  }

  if (result.mutations.length > 0) {
    output.write(`[vinyan] Files modified: ${result.mutations.map((m) => m.file).join(', ')}\n`);
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
