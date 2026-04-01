/**
 * CLI Progress Listener — human-readable status output via bus events.
 *
 * Subscribes to core loop lifecycle events and writes progress to stderr.
 * All output to stderr so stdout stays clean for JSON (Unix philosophy).
 *
 * Pure observer — does not modify core loop behavior (A3 compliance).
 * Source of truth: spec/tdd.md §1A.8, §1C.4
 */
import type { VinyanBus } from '../core/bus.ts';

export interface CLIProgressOptions {
  output?: NodeJS.WritableStream;
  verbose?: boolean;
  color?: boolean;
}

export function attachCLIProgressListener(bus: VinyanBus, options?: CLIProgressOptions): () => void {
  const out = options?.output ?? process.stderr;
  const verbose = options?.verbose ?? false;
  const color = options?.color ?? false;

  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);

  const write = (msg: string) => out.write(msg + '\n');

  const detachers: Array<() => void> = [];

  detachers.push(
    bus.on('task:start', ({ input, routing }) => {
      write(
        `${dim('[vinyan]')} Starting task ${bold(input.id)} at L${routing.level} with ${routing.model ?? 'no model'}`,
      );
    }),
  );

  detachers.push(
    bus.on('worker:dispatch', ({ taskId, routing }) => {
      if (verbose) {
        write(`${dim('[vinyan]')} Dispatching ${taskId} to worker ${dim(`(L${routing.level})`)}`);
      }
    }),
  );

  detachers.push(
    bus.on('oracle:verdict', ({ oracleName, verdict }) => {
      if (verbose) {
        const status = verdict.verified ? green('pass') : red('FAIL');
        const conf = verdict.confidence != null ? ` ${dim(`(confidence: ${verdict.confidence.toFixed(2)})`)}` : '';
        write(`${dim('[vinyan]')}   ${oracleName}: ${status}${conf}`);
      }
    }),
  );

  detachers.push(
    bus.on('task:escalate', ({ fromLevel, toLevel, reason }) => {
      write(`${dim('[vinyan]')} ${yellow('Escalating')} L${fromLevel} → L${toLevel}: ${reason}`);
    }),
  );

  detachers.push(
    bus.on('task:timeout', ({ taskId, elapsed_ms, budget_ms }) => {
      write(`${dim('[vinyan]')} ${red('TIMEOUT')} task ${taskId} after ${elapsed_ms}ms (budget: ${budget_ms}ms)`);
    }),
  );

  detachers.push(
    bus.on('trace:record', ({ trace }) => {
      const quality = trace.qualityScore ? ` ${dim(`(quality: ${trace.qualityScore.composite.toFixed(2)})`)}` : '';
      const outcome = trace.outcome === 'success' ? green(trace.outcome) : red(trace.outcome);
      write(`${dim('[vinyan]')} Attempt: ${outcome}${quality}`);
    }),
  );

  detachers.push(
    bus.on('task:complete', ({ result }) => {
      const status =
        result.status === 'completed'
          ? green('completed')
          : result.status === 'escalated'
            ? yellow('escalated')
            : red('failed');
      write(`${dim('[vinyan]')} Task ${status}: ${result.mutations.length} mutation(s)`);
    }),
  );

  // Evolution engine events
  detachers.push(
    bus.on('evolution:rulesApplied', ({ taskId, rules }) => {
      if (verbose) {
        write(`${dim('[vinyan]')} Applied ${rules.length} evolution rule(s) to ${taskId}`);
      }
    }),
  );

  detachers.push(
    bus.on('evolution:rulePromoted', ({ ruleId, taskSig }) => {
      write(`${dim('[vinyan]')} ${green('Rule promoted')}: ${ruleId} for ${taskSig}`);
    }),
  );

  detachers.push(
    bus.on('evolution:ruleRetired', ({ ruleId, reason }) => {
      write(`${dim('[vinyan]')} ${yellow('Rule retired')}: ${ruleId} — ${reason}`);
    }),
  );

  // Skill events
  detachers.push(
    bus.on('skill:match', ({ taskId, skill }) => {
      if (verbose) {
        write(`${dim('[vinyan]')} Skill match for ${taskId}: ${skill.taskSignature}`);
      }
    }),
  );

  detachers.push(
    bus.on('skill:outcome', ({ skill, success }) => {
      if (verbose) {
        const result = success ? green('success') : red('failure');
        write(`${dim('[vinyan]')} Skill outcome ${skill.taskSignature}: ${result}`);
      }
    }),
  );

  // Sleep cycle
  detachers.push(
    bus.on('sleep:cycleComplete', ({ patternsFound, rulesPromoted, skillsCreated }) => {
      write(
        `${dim('[vinyan]')} Sleep cycle: ${patternsFound} patterns, ${rulesPromoted} rules promoted, ${skillsCreated} skills`,
      );
    }),
  );

  return () => {
    for (const detach of detachers) detach();
  };
}
