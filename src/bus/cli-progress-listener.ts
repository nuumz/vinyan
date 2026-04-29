/**
 * CLI Progress Listener — human-readable status output via bus events.
 *
 * Subscribes to core loop lifecycle events and writes progress to stderr.
 * All output to stderr so stdout stays clean for JSON (Unix philosophy).
 *
 * Pure observer — does not modify core loop behavior (A3 compliance).
 * Source of truth: spec/tdd.md §1A.8, §1C.4
 */
import * as readline from 'readline';
import type { VinyanBus } from '../core/bus.ts';
import type { CommandApprovalGate } from '../orchestrator/tools/command-approval-gate.ts';

export interface CLIProgressOptions {
  output?: NodeJS.WritableStream;
  verbose?: boolean;
  color?: boolean;
  /** Command approval gate — enables interactive approval for unlisted shell commands. */
  commandApprovalGate?: CommandApprovalGate;
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

  const write = (msg: string) => out.write(`${msg}\n`);

  const detachers: Array<() => void> = [];

  detachers.push(
    bus.on('intent:resolved', ({ strategy, confidence, reasoning, type, source }) => {
      const typeTag = type && type !== 'known' ? ` ${yellow(`[${type}]`)}` : '';
      const srcTag = source ? ` ${dim(`<${source}>`)}` : '';
      write(`${dim('[vinyan]')} Intent: ${bold(strategy)}${typeTag}${srcTag} (confidence: ${confidence.toFixed(2)}) — ${reasoning}`);
    }),
  );

  detachers.push(
    bus.on('intent:contradiction', ({ ruleStrategy, llmStrategy, winner }) => {
      write(`${dim('[vinyan]')} ${yellow('Intent conflict')}: rule=${ruleStrategy} vs llm=${llmStrategy}, A5 winner=${bold(winner)}`);
    }),
  );

  detachers.push(
    bus.on('intent:uncertain', ({ reason, clarificationRequest }) => {
      write(`${dim('[vinyan]')} ${yellow('Intent uncertain')}: ${reason}`);
      if (verbose) write(`${dim('[vinyan]')}   ${clarificationRequest}`);
    }),
  );

  detachers.push(
    bus.on('intent:cache_hit', ({ cacheKey }) => {
      if (verbose) write(`${dim('[vinyan]')} Intent: cache hit ${dim(`(${cacheKey.slice(0, 40)}…)`)}`);
    }),
  );

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
    bus.on('task:timeout', ({ taskId, elapsedMs, budgetMs }) => {
      write(`${dim('[vinyan]')} ${red('TIMEOUT')} task ${taskId} after ${elapsedMs}ms (budget: ${budgetMs}ms)`);
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
          : result.status === 'input-required'
            ? yellow('input-required')
            : result.status === 'escalated'
              ? yellow('escalated')
              : red('failed');
      write(`${dim('[vinyan]')} Task ${status}: ${result.mutations.length} mutation(s)`);
    }),
  );

  // Agent session lifecycle — show what the agent is thinking/doing
  detachers.push(
    bus.on('agent:session_start', ({ taskId, routingLevel, budget }) => {
      write(`${dim('[vinyan]')} Agent session started ${dim(`(L${routingLevel}, ${budget.maxTurns} turns, ${budget.maxTokens} tokens)`)}`);
    }),
  );

  detachers.push(
    bus.on('agent:thinking', ({ rationale }) => {
      // Truncate long rationale to keep output scannable
      const text = rationale.length > 200 ? `${rationale.slice(0, 200)}…` : rationale;
      write(`${dim('[vinyan]')} ${dim('💭')} ${text}`);
    }),
  );

  detachers.push(
    bus.on('agent:tool_executed', ({ toolName, durationMs, isError }) => {
      const status = isError ? red('ERR') : green('OK');
      write(`${dim('[vinyan]')}   → ${bold(toolName)} ${status} ${dim(`(${durationMs}ms)`)}`);
    }),
  );

  detachers.push(
    bus.on('agent:turn_complete', ({ tokensConsumed, turnsRemaining }) => {
      if (verbose) {
        write(`${dim('[vinyan]')}   Turn complete — ${dim(`${tokensConsumed} tokens used, ${turnsRemaining} turns left`)}`);
      }
    }),
  );

  detachers.push(
    bus.on('agent:session_end', ({ outcome, tokensConsumed, turnsUsed, durationMs }) => {
      const outcomeStr = outcome === 'completed' ? green(outcome) : outcome === 'uncertain' ? yellow(outcome) : red(outcome);
      write(`${dim('[vinyan]')} Agent session ${outcomeStr} — ${turnsUsed} turns, ${tokensConsumed} tokens, ${dim(`${Math.round(durationMs / 1000)}s`)}`);
    }),
  );

  detachers.push(
    bus.on('agent:tool_denied', ({ toolName, violation }) => {
      write(`${dim('[vinyan]')} ${red('Tool denied')}: ${bold(toolName)}${violation ? ` — ${violation}` : ''}`);
    }),
  );

  // Phase timing
  detachers.push(
    bus.on('phase:timing', ({ phase, durationMs }) => {
      if (verbose) {
        write(`${dim('[vinyan]')}   ${phase} ${dim(`${durationMs}ms`)}`);
      }
    }),
  );

  // Task understanding
  detachers.push(
    bus.on('understanding:layer0_complete', ({ verb, category }) => {
      if (verbose) {
        write(`${dim('[vinyan]')} Understanding: ${bold(verb)} → ${category}`);
      }
    }),
  );

  // Tool remediation events
  detachers.push(
    bus.on('tool:failure_classified', ({ type, recoverable, error }) => {
      const shortError = error.length > 100 ? `${error.slice(0, 100)}...` : error;
      write(`${dim('[vinyan]')} Tool failed: ${bold(type)}${recoverable ? ' (attempting fix)' : ''} — ${dim(shortError)}`);
    }),
  );

  detachers.push(
    bus.on('tool:remediation_attempted', ({ correctedCommand, confidence }) => {
      write(`${dim('[vinyan]')} ${yellow('Retrying')}: ${bold(correctedCommand)} (confidence: ${confidence.toFixed(2)})`);
    }),
  );

  detachers.push(
    bus.on('tool:remediation_succeeded', ({ correctedCommand }) => {
      write(`${dim('[vinyan]')} ${green('Remediation succeeded')}: ${correctedCommand}`);
    }),
  );

  detachers.push(
    bus.on('tool:remediation_failed', ({ reason }) => {
      write(`${dim('[vinyan]')} ${red('Remediation failed')}: ${reason}`);
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

  detachers.push(
    bus.on('evolution:capabilityPromoted', ({ agentId, capabilityId, confidence, observationCount }) => {
      write(
        `${dim('[vinyan]')} ${green('Capability promoted')}: ${agentId} + ${capabilityId} (${confidence.toFixed(2)}, n=${observationCount})`,
      );
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
    bus.on('sleep:cycleComplete', ({ patternsFound, rulesPromoted, skillsCreated, capabilitiesPromoted }) => {
      const capabilityText = capabilitiesPromoted ? `, ${capabilitiesPromoted} capabilities` : '';
      write(
        `${dim('[vinyan]')} Sleep cycle: ${patternsFound} patterns, ${rulesPromoted} rules promoted, ${skillsCreated} skills${capabilityText}`,
      );
    }),
  );

  // Interactive command approval — prompt user for unlisted shell commands
  const approvalGate = options?.commandApprovalGate;
  if (approvalGate) {
    detachers.push(
      bus.on('tool:approval_required', ({ requestId, command, reason }) => {
        write(`${dim('[vinyan]')} ${yellow('⚠ Command not in allowlist:')} ${bold(command)}`);
        write(`${dim('[vinyan]')} ${dim(reason)}`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        rl.question(`${dim('[vinyan]')} Allow this command? [y/N] `, (answer) => {
          rl.close();
          const approved = answer.trim().toLowerCase() === 'y';
          approvalGate.resolve(requestId, approved ? 'approved' : 'rejected');
          if (approved) {
            write(`${dim('[vinyan]')} ${green('Approved')}`);
          } else {
            write(`${dim('[vinyan]')} ${red('Rejected')}`);
          }
        });
      }),
    );
  }

  return () => {
    for (const detach of detachers) detach();
  };
}
