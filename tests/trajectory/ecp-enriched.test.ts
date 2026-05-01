/**
 * ECP-enriched projector + exporter tests.
 *
 * Covers:
 *   - JoinedTraceRow → EcpEnrichedRow shape
 *   - Per-turn Brier/CRPS surfacing via the enrichment context
 *   - Zod schema validation
 *   - Manifest format=ecp-enriched when format=ecp requested
 *   - Redaction runs BEFORE the artifact hash (perturbation moves the hash)
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { OracleVerdict } from '../../src/core/types.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { explainRouting } from '../../src/gate/routing-explainer.ts';
import { toECPEnriched } from '../../src/trajectory/ecp-enriched.ts';
import { EcpEnrichedRowSchema, EcpExportManifestSchema } from '../../src/trajectory/ecp-schemas.ts';
import { buildJoinedRow, exportTrajectories } from '../../src/trajectory/exporter.ts';

function makeTrace() {
  return {
    id: 'trace-x',
    task_id: 'task-x',
    session_id: 'sess-x',
    timestamp: 0,
    routing_level: 2,
    task_type_signature: 'refactor:ts',
    approach: 'inline',
    approach_description: 'inline the helper',
    risk_score: 0.42,
    quality_composite: 0.88,
    model_used: 'claude-sonnet',
    tokens_consumed: 100,
    duration_ms: 500,
    outcome: 'success' as const,
    failure_reason: null,
    oracle_verdicts: '{}',
    affected_files: '[]',
  };
}

function makeTurns() {
  return [
    {
      id: 'turn-a',
      session_id: 'sess-x',
      seq: 0,
      role: 'user' as const,
      blocks_json: JSON.stringify([{ type: 'text', text: 'refactor helper.ts' }]),
      cancelled_at: null,
      created_at: 0,
    },
    {
      id: 'turn-b',
      session_id: 'sess-x',
      seq: 1,
      role: 'assistant' as const,
      blocks_json: JSON.stringify([
        { type: 'text', text: 'OK, I am refactoring.' },
        { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'helper.ts' } },
      ]),
      cancelled_at: null,
      created_at: 0,
    },
  ];
}

function makeRouting() {
  return explainRouting({
    taskId: 'task-x',
    decision: {
      level: 2,
      model: 'claude-sonnet',
      budgetTokens: 50000,
      latencyBudgetMs: 90000,
    },
    factors: {
      blastRadius: 10,
      dependencyDepth: 3,
      testCoverage: 0.8,
      fileVolatility: 5,
      irreversibility: 0,
      hasSecurityImplication: false,
      environmentType: 'development',
    },
  });
}

describe('toECPEnriched', () => {
  test('JoinedTraceRow with 2 turns produces system + human + assistant (3 enriched turns)', () => {
    const joined = buildJoinedRow(makeTrace(), makeTurns());
    const row = toECPEnriched(joined, makeRouting(), {
      redactionApplied: ['home-path'],
      redactionPolicyVersion: 'built-in-v1',
    });
    expect(row.turns.length).toBe(3);
    expect(row.turns[0]?.role).toBe('system');
    expect(row.turns[1]?.role).toBe('human');
    expect(row.turns[2]?.role).toBe('gpt');
  });

  test('Per-turn Brier/CRPS surfaces on the tail assistant turn when tracePrediction supplied', () => {
    const joined = buildJoinedRow(makeTrace(), makeTurns());
    const row = toECPEnriched(joined, makeRouting(), {
      redactionApplied: [],
      redactionPolicyVersion: 'built-in-v1',
      tracePrediction: {
        basis: 'calibrated',
        brier: 0.12,
        crps_blast: 0.4,
        crps_quality: 0.2,
      },
    });
    const tail = row.turns[row.turns.length - 1];
    expect(tail?.prediction_error).toBeDefined();
    expect(tail?.prediction_error?.brier).toBe(0.12);
    expect(tail?.prediction_error?.crps_blast).toBe(0.4);
    expect(tail?.prediction_error?.basis).toBe('calibrated');
  });

  test('Schema validates the projector output', () => {
    const joined = buildJoinedRow(makeTrace(), makeTurns());
    const row = toECPEnriched(joined, makeRouting(), {
      redactionApplied: [],
      redactionPolicyVersion: 'built-in-v1',
    });
    const parsed = EcpEnrichedRowSchema.safeParse(row);
    expect(parsed.success).toBe(true);
  });

  test('Tool calls are surfaced on the assistant turn with args_hash', () => {
    const joined = buildJoinedRow(makeTrace(), makeTurns());
    const row = toECPEnriched(joined, makeRouting(), {
      redactionApplied: [],
      redactionPolicyVersion: 'built-in-v1',
    });
    const asst = row.turns.find((t) => t.role === 'gpt');
    expect(asst?.tool_calls).toBeDefined();
    expect(asst?.tool_calls?.[0]?.name).toBe('read_file');
    expect(asst?.tool_calls?.[0]?.args_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Per-turn verdict attribution via verdictsByTurnId', () => {
    const joined = buildJoinedRow(makeTrace(), makeTurns());
    const verdict: OracleVerdict = {
      verified: true,
      type: 'known',
      confidence: 0.92,
      evidence: [{ file: 'helper.ts', line: 1, snippet: 'x', contentHash: 'h1' }],
      fileHashes: {},
      durationMs: 1,
      oracleName: 'ast',
    };
    const row = toECPEnriched(joined, makeRouting(), {
      redactionApplied: [],
      redactionPolicyVersion: 'built-in-v1',
      verdictsByTurnId: new Map([['turn-b', verdict]]),
    });
    const asst = row.turns.find((t) => t.role === 'gpt');
    expect(asst?.oracle_verdict?.oracle).toBe('ast');
    expect(asst?.oracle_verdict?.status).toBe('verified');
    expect(asst?.oracle_verdict?.evidence_chain.length).toBe(1);
  });

  test('Empty-turns trace synthesizes a minimal human turn from trace metadata', () => {
    const joined = buildJoinedRow(makeTrace(), []);
    const row = toECPEnriched(joined, makeRouting(), {
      redactionApplied: [],
      redactionPolicyVersion: 'built-in-v1',
    });
    expect(row.turns.length).toBeGreaterThanOrEqual(2);
    expect(row.turns[0]?.role).toBe('system');
    const human = row.turns.find((t) => t.role === 'human');
    expect(human?.content).toContain('inline the helper');
  });
});

// ── Exporter integration: ecp format branch ─────────────────────

function seedTrace(db: Database, t: ReturnType<typeof makeTrace>): void {
  if (t.session_id) {
    db.run(
      `INSERT OR IGNORE INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
       VALUES (?, 'test', ?, 'active', NULL, NULL, ?)`,
      [t.session_id, t.timestamp, t.timestamp],
    );
  }
  db.run(
    `INSERT INTO execution_traces (id, task_id, session_id, timestamp, routing_level, approach, approach_description, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, quality_composite, task_type_signature, risk_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      t.id,
      t.task_id,
      t.session_id,
      t.timestamp,
      t.routing_level,
      t.approach,
      t.approach_description,
      t.model_used,
      t.tokens_consumed,
      t.duration_ms,
      t.outcome,
      t.oracle_verdicts,
      t.affected_files,
      t.quality_composite,
      t.task_type_signature,
      t.risk_score,
    ],
  );
  for (const turn of makeTurns()) {
    db.run(
      `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, '{"input":0,"output":0,"cacheRead":0,"cacheCreation":0}', ?, ?)`,
      [turn.id, turn.session_id, turn.seq, turn.role, turn.blocks_json, t.task_id, turn.created_at],
    );
  }
}

let db: Database;
let tmpDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  tmpDir = mkdtempSync(join(tmpdir(), 'vinyan-ecp-'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('exportTrajectories(format=ecp)', () => {
  test('manifest format is "ecp-enriched" when format=ecp requested', async () => {
    const now = Date.now();
    seedTrace(db, { ...makeTrace(), timestamp: now });

    const result = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'out'),
      format: 'ecp',
      vinyanHome: tmpDir,
    });
    expect(result.rowCount).toBe(1);

    const manifestRaw = readFileSync(result.manifestPath, 'utf-8');
    const manifest = EcpExportManifestSchema.parse(JSON.parse(manifestRaw));
    expect(manifest.format).toBe('ecp-enriched');
    expect(manifest.schema_version).toBe('v1');
    expect(manifest.sourceTables).toContain('prediction_ledger');

    // Artifact round-trip produces valid EcpEnrichedRow
    const jsonl = gunzipSync(readFileSync(result.artifactPath)).toString('utf-8');
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const row = EcpEnrichedRowSchema.parse(JSON.parse(lines[0] ?? ''));
    expect(row.schema).toBe('vinyan.ecp.trajectory/v1');
    expect(row.routing.level).toBe(2);
  });

  test('hash stability: identical inputs → identical sha256; redaction bypass perturbs hash', async () => {
    const now = Date.now();
    const trace = { ...makeTrace(), timestamp: now };
    seedTrace(db, trace);

    const a = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'a'),
      format: 'ecp',
      vinyanHome: tmpDir,
      dryRun: true,
    });

    // Seed a second DB with a home-path leak → redaction will rewrite it.
    // The redaction happens BEFORE the hash, so the "after redaction" hash
    // for this run should still differ from run A (different input text).
    const db2 = new Database(':memory:');
    new MigrationRunner().migrate(db2, [migration001]);
    try {
      const leakedTurns = JSON.parse(JSON.stringify(makeTurns()));
      // inject a path into the user message block
      leakedTurns[0].blocks_json = JSON.stringify([{ type: 'text', text: 'refactor /Users/alice/helper.ts' }]);
      db2.run(
        `INSERT OR IGNORE INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at)
         VALUES (?, 'test', ?, 'active', NULL, NULL, ?)`,
        [trace.session_id, trace.timestamp, trace.timestamp],
      );
      db2.run(
        `INSERT INTO execution_traces (id, task_id, session_id, timestamp, routing_level, approach, approach_description, model_used, tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files, quality_composite, task_type_signature, risk_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          trace.id,
          trace.task_id,
          trace.session_id,
          trace.timestamp,
          trace.routing_level,
          trace.approach,
          trace.approach_description,
          trace.model_used,
          trace.tokens_consumed,
          trace.duration_ms,
          trace.outcome,
          trace.oracle_verdicts,
          trace.affected_files,
          trace.quality_composite,
          trace.task_type_signature,
          trace.risk_score,
        ],
      );
      for (const turn of leakedTurns) {
        db2.run(
          `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, cancelled_at, token_count_json, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, '{"input":0,"output":0,"cacheRead":0,"cacheCreation":0}', ?, ?)`,
          [turn.id, turn.session_id, turn.seq, turn.role, turn.blocks_json, trace.task_id, turn.created_at],
        );
      }

      const b = await exportTrajectories(db2, {
        profile: 'default',
        sinceMs: now - 1000,
        outDir: join(tmpDir, 'b'),
        format: 'ecp',
        vinyanHome: tmpDir,
        dryRun: true,
      });

      // Different inputs → different sha256. This is the A4 invariant in
      // action: any mutation visible to the projector changes the hash.
      expect(b.sha256).not.toBe(a.sha256);
    } finally {
      db2.close();
    }
  });

  test('dataset_id is deterministic across repeated ecp exports of identical inputs', async () => {
    const now = Date.now();
    seedTrace(db, { ...makeTrace(), timestamp: now });

    const a = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'a'),
      format: 'ecp',
      vinyanHome: tmpDir,
      dryRun: true,
    });
    const b = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'b'),
      format: 'ecp',
      vinyanHome: tmpDir,
      dryRun: true,
    });
    expect(a.datasetId).toBe(b.datasetId);
    expect(a.sha256).toBe(b.sha256);
  });

  test('ecp and sharegpt formats produce different dataset_ids', async () => {
    const now = Date.now();
    seedTrace(db, { ...makeTrace(), timestamp: now });

    const ecp = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'ecp'),
      format: 'ecp',
      vinyanHome: tmpDir,
      dryRun: true,
    });
    const share = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'share'),
      format: 'sharegpt',
      vinyanHome: tmpDir,
      dryRun: true,
    });
    expect(ecp.datasetId).not.toBe(share.datasetId);
  });

  test('unsupported format throws', async () => {
    await expect(
      exportTrajectories(db, {
        profile: 'default',
        outDir: join(tmpDir, 'x'),
        // @ts-expect-error — invalid format on purpose
        format: 'parquet',
        vinyanHome: tmpDir,
      }),
    ).rejects.toThrow(/Unsupported format/);
  });

  test('ecp artifact contains the embedded routing explanation', async () => {
    const now = Date.now();
    seedTrace(db, { ...makeTrace(), timestamp: now });

    const result = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'out'),
      format: 'ecp',
      vinyanHome: tmpDir,
    });
    const jsonl = gunzipSync(readFileSync(result.artifactPath)).toString('utf-8');
    const row = JSON.parse(jsonl.split('\n').filter(Boolean)[0] ?? '');
    expect(row.routing).toBeDefined();
    expect(row.routing.summary).toMatch(/Task routed to L/);
    expect(row.routing.confidenceSource).toBeDefined();
  });

  test('default format remains "sharegpt" (baseline not regressed)', async () => {
    const now = Date.now();
    seedTrace(db, { ...makeTrace(), timestamp: now });

    const result = await exportTrajectories(db, {
      profile: 'default',
      sinceMs: now - 1000,
      outDir: join(tmpDir, 'default'),
      vinyanHome: tmpDir,
    });
    const manifestRaw = readFileSync(result.manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.format).toBe('sharegpt-baseline');
  });
});
