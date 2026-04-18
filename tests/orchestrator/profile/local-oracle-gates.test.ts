/**
 * LocalOracleGates tests — drift detection via OracleAccuracyStore.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner, ALL_MIGRATIONS } from '../../../src/db/migrations/index.ts';
import { OracleAccuracyStore } from '../../../src/db/oracle-accuracy-store.ts';
import {
  LocalOracleGates,
  type LocalOracleProfile,
} from '../../../src/orchestrator/profile/local-oracle-gates.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  return db;
}

function mkProfile(oracleName: string): LocalOracleProfile {
  return {
    id: `local-oracle-${oracleName}`,
    oracleName,
    status: 'probation',
    createdAt: 0,
    demotionCount: 0,
  };
}

function seedResolvedVerdicts(
  db: Database,
  oracleName: string,
  correct: number,
  wrong: number,
): void {
  const now = Date.now();
  let seq = 0;
  const insert = db.prepare(
    `INSERT INTO oracle_accuracy
       (id, oracle_name, gate_run_id, verdict, confidence, tier, timestamp, affected_files, outcome, outcome_timestamp)
     VALUES (?, ?, ?, 'pass', 0.9, 'deterministic', ?, '[]', ?, ?)`,
  );
  for (let i = 0; i < correct; i++) {
    insert.run(
      `r-${oracleName}-c-${seq++}`,
      oracleName,
      `gr-${oracleName}-c-${i}`,
      now,
      'confirmed_correct',
      now,
    );
  }
  for (let i = 0; i < wrong; i++) {
    insert.run(
      `r-${oracleName}-w-${seq++}`,
      oracleName,
      `gr-${oracleName}-w-${i}`,
      now,
      'confirmed_wrong',
      now,
    );
  }
}

describe('LocalOracleGates — promotion', () => {
  test('promotes when resolved accuracy meets bar', () => {
    const db = freshDb();
    const store = new OracleAccuracyStore(db);
    seedResolvedVerdicts(db, 'ast', 20, 2); // ~91% accuracy, 22 resolved
    const gates = new LocalOracleGates({ accuracyStore: store });
    const verdict = gates.shouldPromote(mkProfile('ast'));
    expect(verdict.promote).toBe(true);
    db.close();
  });

  test('refuses promotion when accuracy is below bar', () => {
    const db = freshDb();
    const store = new OracleAccuracyStore(db);
    seedResolvedVerdicts(db, 'flaky', 10, 12); // < 0.8
    const gates = new LocalOracleGates({ accuracyStore: store });
    const verdict = gates.shouldPromote(mkProfile('flaky'));
    expect(verdict.promote).toBe(false);
    db.close();
  });

  test('refuses promotion when evidence insufficient', () => {
    const db = freshDb();
    const store = new OracleAccuracyStore(db);
    seedResolvedVerdicts(db, 'new', 5, 1); // < probationMinResolved (20)
    const gates = new LocalOracleGates({ accuracyStore: store });
    const verdict = gates.shouldPromote(mkProfile('new'));
    expect(verdict.promote).toBe(false);
    expect(verdict.reason).toContain('insufficient');
    db.close();
  });
});

describe('LocalOracleGates — demotion', () => {
  test('demotes when accuracy drops below floor', () => {
    const db = freshDb();
    const store = new OracleAccuracyStore(db);
    seedResolvedVerdicts(db, 'drift', 10, 20); // ~33%
    const gates = new LocalOracleGates({ accuracyStore: store });
    const verdict = gates.shouldDemote(mkProfile('drift'));
    expect(verdict.demote).toBe(true);
    expect(verdict.reason).toContain('floor');
    db.close();
  });

  test('holds when accuracy is within bounds', () => {
    const db = freshDb();
    const store = new OracleAccuracyStore(db);
    seedResolvedVerdicts(db, 'healthy', 18, 5); // ~78%
    const gates = new LocalOracleGates({ accuracyStore: store });
    const verdict = gates.shouldDemote(mkProfile('healthy'));
    expect(verdict.demote).toBe(false);
    db.close();
  });

  test('holds when evidence insufficient', () => {
    const db = freshDb();
    const store = new OracleAccuracyStore(db);
    seedResolvedVerdicts(db, 'new', 2, 5); // < demotionMinResolved
    const gates = new LocalOracleGates({ accuracyStore: store });
    const verdict = gates.shouldDemote(mkProfile('new'));
    expect(verdict.demote).toBe(false);
    db.close();
  });
});
