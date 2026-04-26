/**
 * `vinyan routing-explain <task_id>` — human or JSON render of a routing
 * decision's observable explanation.
 *
 * The CLI deliberately mirrors the API handler: both consume the same
 * `RoutingTraceProvider` abstraction so a future adapter PR only has to
 * implement the DB-backed provider once.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  handleRoutingExplain,
  type RoutingRecord,
  type RoutingTraceProvider,
} from '../api/routing-explain-endpoint.ts';
import type { RoutingExplanation } from '../gate/routing-explainer.ts';
import type { RiskFactors, RoutingDecision } from '../orchestrator/types.ts';

interface CliFlags {
  taskId: string;
  profile: string;
  json: boolean;
  workspace: string;
}

export interface RoutingExplainCliDeps {
  /** Injected provider; when absent we open the workspace DB. */
  readonly traceStore?: RoutingTraceProvider;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
  readonly exit?: (code: number) => never;
}

export async function runRoutingExplainCommand(
  args: string[],
  opts: {
    workspace?: string;
    profile?: string;
    deps?: RoutingExplainCliDeps;
  } = {},
): Promise<void> {
  const stdout = opts.deps?.stdout ?? ((c: string) => process.stdout.write(c));
  const stderr = opts.deps?.stderr ?? ((c: string) => process.stderr.write(c));
  const exit = opts.deps?.exit ?? ((code: number) => process.exit(code));

  let flags: CliFlags;
  try {
    flags = parseFlags(
      args,
      {
        workspace: opts.workspace ?? process.cwd(),
        profile: opts.profile ?? 'default',
      },
      stderr,
      exit,
    );
  } catch {
    return;
  }

  // If the caller injected a store, skip DB open.
  if (opts.deps?.traceStore) {
    await renderResult(flags, opts.deps.traceStore, stdout, stderr, exit);
    return;
  }

  const vinyanHome = join(flags.workspace, '.vinyan');
  const dbPath = join(vinyanHome, 'vinyan.db');

  if (!existsSync(dbPath)) {
    stderr(`No database found at ${dbPath}\n`);
    stderr(`Run \`vinyan init\` and execute at least one task first.\n`);
    exit(1);
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const provider = createDbTraceProvider(db);
    await renderResult(flags, provider, stdout, stderr, exit);
  } finally {
    db.close();
  }
}

async function renderResult(
  flags: CliFlags,
  provider: RoutingTraceProvider,
  stdout: (c: string) => void,
  stderr: (c: string) => void,
  exit: (code: number) => never,
): Promise<void> {
  const result = await handleRoutingExplain({ taskId: flags.taskId }, { traceStore: provider });

  if (result.status === 404) {
    stderr(`${result.body.error}\n`);
    exit(1);
    return;
  }

  if (flags.json) {
    stdout(`${JSON.stringify(result.body, null, 2)}\n`);
  } else {
    renderHuman(result.body, stdout);
  }
}

// ── Flag parsing ─────────────────────────────────────────────────

function parseFlags(
  args: string[],
  defaults: { workspace: string; profile: string },
  stderr: (c: string) => void,
  exit: (code: number) => never,
): CliFlags {
  const flags: CliFlags = {
    taskId: '',
    profile: defaults.profile,
    json: false,
    workspace: defaults.workspace,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--profile' || a === '-p') {
      const next = args[++i];
      if (!next || next.startsWith('-')) {
        stderr(`Missing value for ${a}\n`);
        exit(2);
        throw new Error('unreachable');
      }
      flags.profile = next;
    } else if (a === '--json') {
      flags.json = true;
    } else if (a === '--workspace') {
      const next = args[++i];
      if (!next || next.startsWith('-')) {
        stderr(`Missing value for --workspace\n`);
        exit(2);
        throw new Error('unreachable');
      }
      flags.workspace = next;
    } else if (a === '--help' || a === '-h') {
      printUsage(stderr);
      exit(0);
      throw new Error('unreachable');
    } else if (a && !a.startsWith('-')) {
      if (!flags.taskId) flags.taskId = a;
    } else if (a?.startsWith('-')) {
      stderr(`Unknown flag: ${a}\n`);
      exit(2);
      throw new Error('unreachable');
    }
  }

  if (!flags.taskId) {
    stderr('Usage: vinyan routing-explain <task_id> [--json] [--profile <p>]\n');
    exit(2);
    throw new Error('unreachable');
  }

  return flags;
}

function printUsage(out: (c: string) => void): void {
  out(`vinyan routing-explain — observable routing for a task

Usage:
  vinyan routing-explain <task_id> [--json] [--profile <p>] [--workspace <path>]

Flags:
  --json        Print the RoutingExplanation as JSON
  --profile     Profile namespace (default: 'default')
  --workspace   Workspace root (default: cwd)
`);
}

// ── Rendering ────────────────────────────────────────────────────

function renderHuman(explanation: RoutingExplanation, out: (c: string) => void): void {
  const lines: string[] = [];
  lines.push(explanation.summary);
  lines.push('');
  lines.push(`  task_id:           ${explanation.taskId}`);
  lines.push(`  level:             L${explanation.level}`);
  lines.push(`  confidence_source: ${explanation.confidenceSource}`);
  if (explanation.escalationReason) {
    lines.push(`  escalated:         ${explanation.escalationReason}`);
  }
  if (explanation.deescalationReason) {
    lines.push(`  de-escalated:      ${explanation.deescalationReason}`);
  }
  lines.push('');
  if (explanation.factors.length > 0) {
    lines.push('  factors (ranked):');
    for (const f of explanation.factors) {
      lines.push(
        `    - ${f.label.padEnd(30)} raw=${String(f.rawValue).padEnd(10)} contrib=${f.weightedContribution.toFixed(3)}`,
      );
    }
  } else {
    lines.push('  factors: (none)');
  }
  lines.push('');
  lines.push(`  oracles planned:   ${explanation.oraclesPlanned.join(', ') || '(none)'}`);
  if (explanation.oraclesActual && explanation.oraclesActual.length > 0) {
    lines.push('  oracles actual:');
    for (const o of explanation.oraclesActual) {
      lines.push(`    - ${o.name}: ${o.verdict} (confidence=${o.confidence.toFixed(2)})`);
    }
  }
  out(`${lines.join('\n')}\n`);
}

// ── DB-backed trace provider ─────────────────────────────────────

/**
 * Minimum DB adapter for `execution_traces`. Reconstructs a minimal
 * RoutingRecord from the persisted trace columns. Per-trace RiskFactors
 * are not persisted yet — we emit a neutral RiskFactors (same shape the
 * exporter uses) so the explainer produces a deterministic payload.
 * When a future migration persists factors, swap this adapter over.
 */
export function createDbTraceProvider(db: Database): RoutingTraceProvider {
  return {
    getRoutingRecord(taskId: string): RoutingRecord | null {
      const row = db
        .prepare(
          `SELECT id, task_id, routing_level, model_used, risk_score
             FROM execution_traces
            WHERE task_id = ?
            ORDER BY timestamp DESC
            LIMIT 1`,
        )
        .get(taskId) as {
        id: string;
        task_id: string;
        routing_level: number;
        model_used: string;
        risk_score: number | null;
      } | null;

      if (!row) return null;

      const level = clampLevel(row.routing_level);
      const decision: RoutingDecision = {
        level,
        model: row.model_used,
        budgetTokens: 0,
        latencyBudgetMs: 0,
        ...(row.risk_score != null ? { riskScore: row.risk_score } : {}),
      };
      const factors: RiskFactors = {
        blastRadius: 0,
        dependencyDepth: 0,
        testCoverage: 1.0,
        fileVolatility: 0,
        irreversibility: 0,
        hasSecurityImplication: false,
        environmentType: 'development',
      };
      return {
        taskId: row.task_id,
        decision,
        factors,
      };
    },
  };
}

function clampLevel(n: number): 0 | 1 | 2 | 3 {
  if (n <= 0) return 0;
  if (n >= 3) return 3;
  return n as 0 | 1 | 2 | 3;
}
