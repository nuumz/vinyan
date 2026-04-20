/**
 * Trajectory Exporter tests — behavior, not internal structure.
 *
 * Each test seeds an in-memory SQLite DB with a deterministic set of
 * execution_traces + session_turns rows, runs `exportTrajectories`, and
 * asserts on observable outputs: manifest contents, artifact round-trip,
 * determinism of dataset_id, filter narrowing, dry-run behavior.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { migration005 } from '../../src/db/migrations/005_trajectory_export.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { buildJoinedRow, exportTrajectories, toShareGPT } from '../../src/trajectory/exporter.ts';
import { BUILT_IN_POLICY } from '../../src/trajectory/redaction.ts';
import { ExportManifestSchema, ShareGPTRowSchema } from '../../src/trajectory/schemas.ts';

interface SeedTrace {
  id: string;
  sessionId: string | null;
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  quality?: number;
  turns?: SeedTurn[];
  routingLevel?: number;
}

interface SeedTurn {
  seq: number;
  role: 'user' | 'assistant';
  blocks: unknown[];
}

function seedTrace(db: Database, t: SeedTrace, timestamp = Date.now()): void {
  if (t.sessionId) {
    db.run(
      `INSERT OR IGNORE INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
       VALUES (?, 'test', ?, 'active', NULL, NULL, ?)`,
      [t.sessionId, timestamp, timestamp],
    );
  }
  db.run(
    `INSERT INTO execution_traces (id, task_id, session_id, timestamp, routing_level, approach, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, quality_composite)
     VALUES (?, ?, ?, ?, ?, 'refactor', 'mock/model', 100, 500, ?, '{}', '[]', ?)`,
    [t.id, `task-${t.id}`, t.sessionId, timestamp, t.routingLevel ?? 1, t.outcome, t.quality ?? null],
  );
  if (t.sessionId && t.turns) {
    for (const turn of t.turns) {
      db.run(
        `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, '{"input":0,"output":0,"cacheRead":0,"cacheCreation":0}', ?, ?)`,
        [
          `${t.id}-turn-${turn.seq}`,
          t.sessionId,
          turn.seq,
          turn.role,
          JSON.stringify(turn.blocks),
          `task-${t.id}`,
          timestamp + turn.seq,
        ],
      );
    }
  }
}

let db: Database;
let tmpDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001, migration005]);
  tmpDir = mkdtempSync(join(tmpdir(), 'vinyan-traj-'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('exportTrajectories', () => {
  test('exports ShareGPT rows with validated manifest and decodable artifact', async () => {
    const now = Date.now();
    seedTrace(
      db,
      {
        id: 'trace-a',
        sessionId: 'sess-a',
        outcome: 'success',
        quality: 0.9,
        turns: [
          { seq: 0, role: 'user', blocks: [{ type: 'text', text: 'refactor util.ts' }] },
          {
            seq: 1,
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'Starting the refactor.' },
              { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'util.ts' } },
            ],
          },
        ],
      },
      now,
    );
    seedTrace(
      db,
      {
        id: 'trace-b',
        sessionId: 'sess-b',
        outcome: 'failure',
        turns: [
          { seq: 0, role: 'user', blocks: [{ type: 'text', text: 'add logging' }] },
          { seq: 1, role: 'assistant', blocks: [{ type: 'text', text: 'I tried but oracle failed.' }] },
        ],
      },
      now + 1000,
    );
    seedTrace(
      db,
      {
        id: 'trace-c',
        sessionId: null,
        outcome: 'success',
      },
      now + 2000,
    );

    const result = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'out'),
      vinyanHome: tmpDir,
    });

    expect(result.rowCount).toBe(3);
    expect(result.dryRun).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.datasetId).toMatch(/^[0-9a-f]{16}$/);

    // Manifest round-trip
    const manifestRaw = readFileSync(result.manifestPath, 'utf-8');
    const manifest = ExportManifestSchema.parse(JSON.parse(manifestRaw));
    expect(manifest.rowCount).toBe(3);
    expect(manifest.sha256).toBe(result.sha256);
    expect(manifest.sourceTables).toContain('execution_traces');
    expect(manifest.sourceTables).toContain('session_turns');

    // Artifact round-trip
    const gz = readFileSync(result.artifactPath);
    const jsonl = gunzipSync(gz).toString('utf-8');
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const row = ShareGPTRowSchema.parse(JSON.parse(line));
      expect(row.metadata.source).toBe('vinyan');
      expect(row.metadata.profile).toBe('default');
      expect(row.conversations.length).toBeGreaterThan(0);
    }

    // The trace with a tool_use should carry a tools[] array with args_hash
    const traceA = lines.map((l) => JSON.parse(l)).find((r: { id: string }) => r.id === 'trace-a') as {
      tools?: Array<{ args_hash: string }>;
    };
    expect(traceA.tools).toBeDefined();
    expect(traceA.tools?.[0]?.args_hash).toMatch(/^[0-9a-f]{64}$/);

    // DB pointer row was written
    const ptr = db.query('SELECT * FROM trajectory_exports WHERE dataset_id = ?').get(result.datasetId) as
      | { row_count: number; artifact_sha256: string }
      | undefined;
    expect(ptr).toBeDefined();
    expect(ptr?.row_count).toBe(3);
    expect(ptr?.artifact_sha256).toBe(result.sha256);
  });

  test('outcome filter narrows the result', async () => {
    const now = Date.now();
    seedTrace(db, { id: 't1', sessionId: null, outcome: 'success' }, now);
    seedTrace(db, { id: 't2', sessionId: null, outcome: 'failure' }, now + 1);
    seedTrace(db, { id: 't3', sessionId: null, outcome: 'success' }, now + 2);

    const result = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outcome: ['success'],
      outDir: join(tmpDir, 'out'),
      vinyanHome: tmpDir,
    });

    expect(result.rowCount).toBe(2);
    const jsonl = gunzipSync(readFileSync(result.artifactPath)).toString('utf-8');
    const ids = jsonl
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).id as string)
      .sort();
    expect(ids).toEqual(['t1', 't3']);
  });

  test('dryRun skips file writes but still returns manifest', async () => {
    const now = Date.now();
    seedTrace(db, { id: 't1', sessionId: null, outcome: 'success' }, now);

    const outDir = join(tmpDir, 'no-write');
    const result = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir,
      dryRun: true,
      vinyanHome: tmpDir,
    });

    expect(result.dryRun).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    // No files created
    expect(() => readFileSync(result.artifactPath)).toThrow();
    // No pointer row either (Bun.sqlite returns `null` for no-row).
    const ptr = db.query('SELECT * FROM trajectory_exports WHERE dataset_id = ?').get(result.datasetId);
    expect(ptr).toBeNull();
  });

  test('dataset_id is deterministic for identical filter + rows + policy', async () => {
    const now = Date.now();
    seedTrace(db, { id: 't1', sessionId: null, outcome: 'success' }, now);
    seedTrace(db, { id: 't2', sessionId: null, outcome: 'success' }, now + 1);

    const a = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'a'),
      dryRun: true,
      vinyanHome: tmpDir,
    });
    const b = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'b'),
      dryRun: true,
      vinyanHome: tmpDir,
    });

    expect(a.datasetId).toBe(b.datasetId);
    expect(a.sha256).toBe(b.sha256);
  });

  test('empty result produces rowCount=0 without throwing', async () => {
    const result = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: Date.now() + 60_000, // future → no rows
      outDir: join(tmpDir, 'empty'),
      dryRun: true,
      vinyanHome: tmpDir,
    });
    expect(result.rowCount).toBe(0);
  });
});

describe('buildJoinedRow / toShareGPT (projector split)', () => {
  test('buildJoinedRow extracts tool_use blocks from assistant turns', () => {
    const trace = {
      id: 'x',
      task_id: 't',
      session_id: 's',
      timestamp: 0,
      routing_level: 1,
      task_type_signature: null,
      approach: 'refactor',
      approach_description: null,
      risk_score: null,
      quality_composite: null,
      model_used: 'm',
      tokens_consumed: 0,
      duration_ms: 0,
      outcome: 'success' as const,
      failure_reason: null,
      oracle_verdicts: '{}',
      affected_files: '[]',
    };
    const turns = [
      {
        id: 'turn-1',
        session_id: 's',
        seq: 0,
        role: 'assistant' as const,
        blocks_json: JSON.stringify([
          { type: 'tool_use', id: 'tu-a', name: 'grep', input: { pattern: 'foo' } },
          { type: 'tool_use', id: 'tu-b', name: 'read_file', input: { path: 'bar' } },
        ]),
        cancelled_at: null,
        created_at: 0,
      },
    ];
    const joined = buildJoinedRow(trace, turns);
    expect(joined.toolCalls.length).toBe(2);
    expect(joined.toolCalls[0]?.name).toBe('grep');
    expect(joined.toolCalls[0]?.argsHash).toMatch(/^[0-9a-f]{64}$/);
    // Different inputs → different hashes
    expect(joined.toolCalls[0]?.argsHash).not.toBe(joined.toolCalls[1]?.argsHash);
  });

  test('toShareGPT synthesizes a minimal row when session_turns is empty', () => {
    const trace = {
      id: 'x',
      task_id: 't',
      session_id: null,
      timestamp: 0,
      routing_level: 2,
      task_type_signature: 'refactor:ts',
      approach: 'inline',
      approach_description: 'Inline the helper',
      risk_score: null,
      quality_composite: null,
      model_used: 'm',
      tokens_consumed: 0,
      duration_ms: 0,
      outcome: 'success' as const,
      failure_reason: null,
      oracle_verdicts: '{}',
      affected_files: '[]',
    };
    const joined = buildJoinedRow(trace, []);
    const row = toShareGPT(joined, { profile: 'p', policy: BUILT_IN_POLICY });
    expect(row.id).toBe('x');
    expect(row.conversations.length).toBeGreaterThanOrEqual(2);
    expect(row.conversations[0]?.from).toBe('system');
    // Minimal synthesized human turn uses approach_description when present
    const human = row.conversations.find((c) => c.from === 'human');
    expect(human?.value).toContain('Inline the helper');
    expect(row.metadata.routing_level).toBe(2);
  });
});
