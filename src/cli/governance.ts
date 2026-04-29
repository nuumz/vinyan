/**
 * vinyan governance — inspect persisted governance decisions (A8 / T2).
 *
 * Usage:
 *   vinyan governance search [filters]    Search persisted decisions
 *   vinyan governance replay <decisionId>  Show full decision provenance
 *
 * Search filters:
 *   --decision-id <id>          Exact decision id match
 *   --policy-version <v>        Filter by policy version
 *   --actor <name>              Filter by governance actor (attributedTo)
 *   --from <ms>                 Decision timestamp >= ms (epoch ms)
 *   --to <ms>                   Decision timestamp <= ms (epoch ms)
 *   --limit <n>                 Max rows (default 50, max 500)
 *   --offset <n>                Pagination offset
 *   --json                      Raw JSON output
 *   --workspace <path>          Override workspace root
 */

import { join } from 'path';
import { buildDecisionReplay, formatReplayForCLI } from '../db/governance-query.ts';
import { TraceStore } from '../db/trace-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';

export async function runGovernanceCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return;
  }

  const workspace = parseFlag(argv, '--workspace') ?? process.cwd();
  const dbPath = join(workspace, '.vinyan', 'vinyan.db');

  let db: VinyanDB;
  try {
    db = new VinyanDB(dbPath);
  } catch {
    console.error('Database not found. Run a task first to initialize the database.');
    process.exit(1);
    return;
  }

  const store = new TraceStore(db.getDb());
  try {
    if (sub === 'search') {
      runSearch(store, argv.slice(1));
      return;
    }
    if (sub === 'replay') {
      runReplay(store, argv.slice(1));
      return;
    }
    console.error(`Unknown subcommand: ${sub}`);
    printUsage();
    process.exit(2);
  } finally {
    db.close();
  }
}

function runSearch(store: TraceStore, argv: string[]): void {
  const json = argv.includes('--json');
  const result = store.queryGovernance({
    decisionId: parseFlag(argv, '--decision-id'),
    policyVersion: parseFlag(argv, '--policy-version'),
    governanceActor: parseFlag(argv, '--actor'),
    decisionFrom: parseNum(argv, '--from'),
    decisionTo: parseNum(argv, '--to'),
    limit: parseNum(argv, '--limit'),
    offset: parseNum(argv, '--offset'),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.rows.length === 0) {
    console.log('No governance decisions matched.');
    return;
  }

  console.log(`\n  Governance Decisions (${result.rows.length} of ${result.total}, offset=${result.offset})\n`);
  console.log(`  ${'Decision ID'.padEnd(40)}${'Actor'.padEnd(28)}${'Policy'.padEnd(28)}${'Outcome'.padEnd(10)}When`);
  console.log(`  ${'─'.repeat(120)}`);
  for (const row of result.rows) {
    const decision = (row.decisionId ?? '(legacy)').slice(0, 38).padEnd(40);
    const actor = (row.governanceActor ?? '-').slice(0, 26).padEnd(28);
    const policy = (row.policyVersion ?? '-').slice(0, 26).padEnd(28);
    const outcome = row.outcome.padEnd(10);
    const when = row.decidedAt != null ? new Date(row.decidedAt).toISOString() : new Date(row.timestamp).toISOString();
    console.log(`  ${decision}${actor}${policy}${outcome}${when}`);
  }
  console.log();
}

function runReplay(store: TraceStore, argv: string[]): void {
  const json = argv.includes('--json');
  const positional = argv.find((a, i) => i === 0 && !a.startsWith('-'));
  const decisionId = positional ?? parseFlag(argv, '--decision-id');
  if (!decisionId) {
    console.error('Decision id required. Usage: vinyan governance replay <decisionId>');
    process.exit(2);
  }
  const trace = store.findTraceByDecisionId(decisionId);
  if (!trace) {
    console.error(`No trace found for decision: ${decisionId}`);
    process.exit(1);
  }
  const summary = buildDecisionReplay(decisionId, trace);
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`\n${formatReplayForCLI(summary)}\n`);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function parseNum(argv: string[], flag: string): number | undefined {
  const raw = parseFlag(argv, flag);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function printUsage(): void {
  console.log(`vinyan governance — inspect persisted governance decisions

Usage:
  vinyan governance search [filters]
  vinyan governance replay <decisionId>

Search filters:
  --decision-id <id>       Exact decision id
  --policy-version <v>     Filter by policy version
  --actor <name>           Filter by governance actor (attributedTo)
  --from <epoch-ms>        Decision timestamp >= ms
  --to <epoch-ms>          Decision timestamp <= ms
  --limit <n>              Max rows (default 50, max 500)
  --offset <n>             Pagination offset
  --json                   JSON output
  --workspace <path>       Override workspace root
`);
}
