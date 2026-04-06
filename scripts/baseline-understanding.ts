#!/usr/bin/env bun
/**
 * STU Phase A0: Baseline Understanding Measurement
 *
 * Offline script that measures current Layer 0 understanding accuracy
 * on historical execution traces. Establishes the "before" baseline
 * for success criteria in the system design (§9).
 *
 * Measurements:
 * 1. Recurring issue detection rate
 * 2. Action category distribution
 * 3. Task type signature distribution
 *
 * Limitation: ExecutionTrace does NOT store original goal text,
 * so entity resolution recall/precision cannot be measured directly.
 * Full measurement requires Phase D (understanding snapshot in traces).
 *
 * Usage: bun run scripts/baseline-understanding.ts [--db path]
 */
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag >= 0 && args[dbFlag + 1]
  ? resolve(args[dbFlag + 1]!)
  : resolve(process.cwd(), '.vinyan', 'vinyan.db');

// ── Open DB ─────────────────────────────────────────────────────────────

let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`Failed to open database at ${dbPath}:`, err);
  process.exit(1);
}

console.log(`\n=== STU Phase A0: Baseline Understanding Measurement ===`);
console.log(`Database: ${dbPath}\n`);

// ── 1. Total trace count ────────────────────────────────────────────────

interface TraceRow {
  id: string;
  task_type_signature: string | null;
  outcome: string;
  affected_files: string | null;
  oracle_verdicts: string | null;
  duration_ms: number;
}

const traces = db.prepare(`
  SELECT id, task_type_signature, outcome, affected_files, oracle_verdicts, duration_ms
  FROM execution_traces
  ORDER BY timestamp DESC
  LIMIT 500
`).all() as TraceRow[];

console.log(`Total traces loaded: ${traces.length}`);

if (traces.length === 0) {
  console.log('No traces found. Baseline measurement requires at least 1 trace.');
  db.close();
  process.exit(0);
}

// ── 2. Action category distribution ─────────────────────────────────────

const categoryCount: Record<string, number> = {};
const verbCount: Record<string, number> = {};

for (const trace of traces) {
  const sig = trace.task_type_signature ?? 'unknown';
  const verb = sig.split('::')[0] ?? 'unknown';

  verbCount[verb] = (verbCount[verb] ?? 0) + 1;

  // Infer category from verb (mirrors task-understanding.ts logic)
  const MUTATION_VERBS = new Set(['fix', 'add', 'remove', 'update', 'refactor', 'rename', 'move', 'extract', 'inline', 'optimize', 'migrate', 'convert', 'implement', 'delete', 'create']);
  const ANALYSIS_VERBS = new Set(['analyze', 'explain', 'describe', 'review', 'audit', 'inspect', 'summarize']);
  const INVESTIGATION_VERBS = new Set(['investigate', 'debug', 'trace', 'find', 'diagnose', 'why']);
  const DESIGN_VERBS = new Set(['design', 'plan', 'architect', 'propose', 'suggest']);

  let category = 'mutation'; // default
  if (MUTATION_VERBS.has(verb)) category = 'mutation';
  else if (ANALYSIS_VERBS.has(verb)) category = 'analysis';
  else if (INVESTIGATION_VERBS.has(verb)) category = 'investigation';
  else if (DESIGN_VERBS.has(verb)) category = 'design';
  else category = 'unknown';

  categoryCount[category] = (categoryCount[category] ?? 0) + 1;
}

console.log('\n--- Action Category Distribution ---');
for (const [cat, count] of Object.entries(categoryCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${count} (${((count / traces.length) * 100).toFixed(1)}%)`);
}

console.log('\n--- Top Verbs ---');
for (const [verb, count] of Object.entries(verbCount).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${verb}: ${count}`);
}

// ── 3. Recurring issue detection ────────────────────────────────────────

// Group by (first affected file, verb) to detect recurring issues
const fileVerbGroups = new Map<string, number>();
for (const trace of traces) {
  const files: string[] = trace.affected_files ? JSON.parse(trace.affected_files) : [];
  const firstFile = files[0];
  if (!firstFile) continue;

  const sig = trace.task_type_signature ?? 'unknown';
  const verb = sig.split('::')[0] ?? 'unknown';
  const key = `${firstFile}::${verb}`;
  fileVerbGroups.set(key, (fileVerbGroups.get(key) ?? 0) + 1);
}

const recurringThreshold = 3;
const recurringGroups = [...fileVerbGroups.entries()].filter(([, count]) => count >= recurringThreshold);
const totalGroupsWithFiles = fileVerbGroups.size;

console.log('\n--- Recurring Issue Detection ---');
console.log(`  Total (file, verb) groups: ${totalGroupsWithFiles}`);
console.log(`  Recurring groups (≥${recurringThreshold} occurrences): ${recurringGroups.length}`);
if (totalGroupsWithFiles > 0) {
  console.log(`  Recurring rate: ${((recurringGroups.length / totalGroupsWithFiles) * 100).toFixed(1)}%`);
}

if (recurringGroups.length > 0) {
  console.log('\n  Top recurring issues:');
  recurringGroups
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([key, count]) => {
      console.log(`    ${key}: ${count} occurrences`);
    });
}

// ── 4. Outcome distribution ─────────────────────────────────────────────

const outcomeCount: Record<string, number> = {};
for (const trace of traces) {
  outcomeCount[trace.outcome] = (outcomeCount[trace.outcome] ?? 0) + 1;
}

console.log('\n--- Outcome Distribution ---');
for (const [outcome, count] of Object.entries(outcomeCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome}: ${count} (${((count / traces.length) * 100).toFixed(1)}%)`);
}

// ── 5. Oracle failure distribution ──────────────────────────────────────

const oracleFailCount = new Map<string, number>();
let tracesWithVerdicts = 0;
for (const trace of traces) {
  if (!trace.oracle_verdicts) continue;
  const verdicts: Record<string, boolean> = JSON.parse(trace.oracle_verdicts);
  tracesWithVerdicts++;
  for (const [oracle, passed] of Object.entries(verdicts)) {
    if (!passed) {
      oracleFailCount.set(oracle, (oracleFailCount.get(oracle) ?? 0) + 1);
    }
  }
}

console.log('\n--- Oracle Failure Distribution ---');
console.log(`  Traces with oracle verdicts: ${tracesWithVerdicts}`);
if (oracleFailCount.size > 0) {
  for (const [oracle, count] of [...oracleFailCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${oracle}: ${count} failures (${((count / tracesWithVerdicts) * 100).toFixed(1)}%)`);
  }
}

// ── 6. Task type signature distribution ─────────────────────────────────

const sigCount = new Map<string, number>();
for (const trace of traces) {
  const sig = trace.task_type_signature ?? 'unknown';
  sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
}

console.log('\n--- Task Type Signature Distribution ---');
console.log(`  Distinct signatures: ${sigCount.size}`);
for (const [sig, count] of [...sigCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${sig}: ${count}`);
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log('\n=== Baseline Summary ===');
console.log(`  Total traces: ${traces.length}`);
console.log(`  Distinct task signatures: ${sigCount.size}`);
console.log(`  Recurring (file,verb) groups: ${recurringGroups.length} / ${totalGroupsWithFiles}`);
console.log(`  Overall fail rate: ${(((outcomeCount['failure'] ?? 0) / traces.length) * 100).toFixed(1)}%`);
console.log(`  NOTE: Entity resolution recall/precision cannot be measured without goal text in traces.`);
console.log(`        Full measurement requires Phase D (understanding snapshot storage).\n`);

db.close();
