/**
 * vinyan logs — inspect execution traces.
 *
 * Usage:
 *   vinyan logs                    Show recent traces (default 20)
 *   vinyan logs --limit 50         Show N recent traces
 *   vinyan logs --status failed    Filter by outcome
 *   vinyan logs --task-id <id>     Show specific trace detail
 *   vinyan logs --json             Raw JSON output
 */

import { join } from 'path';
import { TraceStore } from '../db/trace-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';

export async function runLogsCommand(argv: string[]): Promise<void> {
  const workspace = parseSingleFlag(argv, '--workspace') ?? process.cwd();
  const limit = parseInt(parseSingleFlag(argv, '--limit') ?? '20', 10);
  const statusFilter = parseSingleFlag(argv, '--status');
  const taskId = parseSingleFlag(argv, '--task-id');
  const jsonOutput = argv.includes('--json');

  const dbPath = join(workspace, '.vinyan', 'vinyan.db');
  let db: VinyanDB;
  try {
    db = new VinyanDB(dbPath);
  } catch {
    console.error('Database not found. Run a task first to initialize the database.');
    process.exit(1);
    return;
  }

  const traceStore = new TraceStore(db.getDb());

  try {
    // Single trace detail
    if (taskId) {
      const traces = traceStore.findRecent(100).filter((t) => t.taskId === taskId || t.id === taskId);
      if (traces.length === 0) {
        console.error(`No traces found for task: ${taskId}`);
        process.exit(1);
      }
      if (jsonOutput) {
        console.log(JSON.stringify(traces, null, 2));
      } else {
        for (const t of traces) {
          console.log(`\n  Trace: ${t.id}`);
          console.log(`  Task:     ${t.taskId}`);
          console.log(`  Outcome:  ${colorOutcome(t.outcome)}`);
          console.log(`  Route:    L${t.routingLevel}`);
          console.log(`  Model:    ${t.modelUsed ?? '-'}`);
          console.log(`  Tokens:   ${t.tokensConsumed}`);
          console.log(`  Duration: ${t.durationMs}ms`);
          console.log(`  Files:    ${t.affectedFiles?.join(', ') || '-'}`);
          if (t.qualityScore) {
            console.log(`  Quality:  ${t.qualityScore.composite.toFixed(2)} (${t.qualityScore.dimensionsAvailable}D)`);
          }
          console.log();
        }
      }
      return;
    }

    // Recent traces list
    const traces = traceStore.findRecent(limit);
    const filtered = statusFilter ? traces.filter((t) => t.outcome === statusFilter) : traces;

    if (jsonOutput) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    if (filtered.length === 0) {
      console.log('No traces found.');
      return;
    }

    console.log(`\n  Recent Traces (${filtered.length})\n`);
    console.log('  ' + 'Task ID'.padEnd(24) + 'Outcome'.padEnd(12) + 'Route'.padEnd(8) + 'Tokens'.padEnd(10) + 'Duration'.padEnd(12) + 'Model');
    console.log('  ' + '─'.repeat(90));

    for (const t of filtered) {
      const id = (t.taskId ?? t.id).slice(0, 22).padEnd(24);
      const outcome = colorOutcome(t.outcome).padEnd(20); // padEnd accounts for ANSI
      const route = `L${t.routingLevel}`.padEnd(8);
      const tokens = String(t.tokensConsumed).padEnd(10);
      const dur = `${t.durationMs}ms`.padEnd(12);
      const model = (t.modelUsed ?? '-').slice(0, 30);
      console.log(`  ${id}${outcome}${route}${tokens}${dur}${model}`);
    }
    console.log();
  } finally {
    db.close();
  }
}

function colorOutcome(outcome: string): string {
  switch (outcome) {
    case 'success':
      return `\x1b[32m${outcome}\x1b[0m`;
    case 'failure':
      return `\x1b[31m${outcome}\x1b[0m`;
    case 'escalated':
      return `\x1b[33m${outcome}\x1b[0m`;
    default:
      return outcome;
  }
}

function parseSingleFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
