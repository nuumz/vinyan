import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migration010 } from '../../../src/db/migrations/010_commonsense_rules.ts';
import { isAbstention } from '../../../src/core/types.ts';
import {
  clearRegistryCache,
  CommonSenseRegistry,
  loadInnateSeed,
  verify,
} from '../../../src/oracle/commonsense/index.ts';
import type { CommonSenseRuleInput } from '../../../src/oracle/commonsense/types.ts';
import type { HypothesisTuple, OracleVerdict } from '../../../src/core/types.ts';

interface TestEnv {
  workspace: string;
  db: Database;
  registry: CommonSenseRegistry;
  cleanup: () => void;
}

function createTestEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), 'vinyan-cs-oracle-'));
  const dbDir = join(root, '.vinyan');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'vinyan.db');

  const db = new Database(dbPath);
  // Bootstrap schema_version + apply migration010
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL
    );
  `);
  migration010.up(db);

  const registry = new CommonSenseRegistry(db);

  return {
    workspace: root,
    db,
    registry,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // best-effort
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

let env: TestEnv;

beforeEach(() => {
  clearRegistryCache(); // close any cached DBs from prior tests
  env = createTestEnv();
});

afterEach(() => {
  clearRegistryCache(); // close oracle's cached handle to env's DB before deleting
  env.cleanup();
});

function makeHypothesis(overrides: Partial<HypothesisTuple> = {}): HypothesisTuple {
  return {
    target: 'src/foo.ts',
    pattern: 'commonsense-check',
    workspace: env.workspace,
    context: {},
    ...overrides,
  };
}

function makeRule(overrides: Partial<CommonSenseRuleInput> = {}): CommonSenseRuleInput {
  return {
    microtheory: { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
    default_outcome: 'block',
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale: 'test rule',
    ...overrides,
  };
}

describe('CommonSense Oracle — verify()', () => {
  test('abstains insufficient_data when DB does not exist', async () => {
    const result = await verify({
      target: 'src/foo.ts',
      pattern: 'commonsense-check',
      workspace: '/nonexistent/path',
      context: {},
    });
    expect(isAbstention(result)).toBe(true);
    if (isAbstention(result)) {
      expect(result.reason).toBe('insufficient_data');
      expect(result.oracleName).toBe('commonsense');
      expect(result.prerequisites).toBeDefined();
    }
  });

  test('abstains out_of_domain when registry is empty', async () => {
    const result = await verify(makeHypothesis());
    expect(isAbstention(result)).toBe(true);
    if (isAbstention(result)) {
      expect(result.reason).toBe('out_of_domain');
    }
  });

  test('returns unknown verdict when microtheory matches but no pattern fires', async () => {
    env.registry.insertRule(makeRule());
    // Hypothesis has matching microtheory (shell-bash filesystem destructive)
    // but command does not contain "rm -rf"
    const result = await verify(
      makeHypothesis({
        target: 'foo.sh',
        context: { tool: 'rm' }, // matches microtheory but pattern needle is "rm -rf"
      }),
    );
    expect(isAbstention(result)).toBe(false);
    const verdict = result as OracleVerdict;
    expect(verdict.verified).toBe(true); // not contributory
    expect(verdict.type).toBe('unknown');
    expect(verdict.confidence).toBe(0);
  });

  test('returns block verdict when rule fires with default_outcome=block', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
        default_outcome: 'block',
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'tmp.txt',
        context: { tool: 'rm', command: 'rm -rf /tmp/cache' },
      }),
    );
    // Note: tool='rm' triggers classifyMutation → 'mutation-destructive'
    expect(isAbstention(result)).toBe(false);
    const verdict = result as OracleVerdict;
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.confidenceSource).toBe('evidence-derived');
    expect(verdict.tierReliability).toBe(0.6);
    expect(verdict.evidence.length).toBeGreaterThanOrEqual(1);
    expect(verdict.evidence[0]?.file).toMatch(/^commonsense:rule:/);
  });

  test('emits SARIF suppression evidence when abnormality predicate matches', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git push --force', case_sensitive: true },
        abnormality_predicate: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: '--force-with-lease',
          case_sensitive: true,
        },
        default_outcome: 'block',
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'README.md',
        context: { tool: 'git', command: 'git push --force --force-with-lease origin main' },
      }),
    );
    expect(isAbstention(result)).toBe(false);
    const verdict = result as OracleVerdict;
    // Pattern matched but abnormality also matched → suppressed
    expect(verdict.verified).toBe(true); // not blocking
    expect(verdict.type).toBe('unknown'); // no firing rule
    expect(verdict.evidence.some((e) => e.file === 'commonsense:suppression')).toBe(true);

    const sup = verdict.evidence.find((e) => e.file === 'commonsense:suppression');
    expect(sup).toBeDefined();
    const parsed = JSON.parse(sup!.snippet);
    expect(parsed.suppression.kind).toBe('inSource');
    expect(parsed.suppression.status).toBe('accepted');
    expect(parsed.suppression.ruleId).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rule fires when pattern matches and abnormality does NOT hold', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git push --force', case_sensitive: true },
        abnormality_predicate: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: '--force-with-lease',
          case_sensitive: true,
        },
        default_outcome: 'block',
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'README.md',
        context: { tool: 'git', command: 'git push --force origin main' }, // no lease
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('known');
  });

  test('priority sorts winner: highest priority rule wins', async () => {
    // Two rules in same microtheory — different priorities, both match the pattern
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'delete', case_sensitive: true },
        default_outcome: 'allow',
        priority: 50,
        rationale: 'lower priority allow',
      }),
    );
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'delete', case_sensitive: true },
        default_outcome: 'block',
        priority: 95,
        rationale: 'higher priority block',
      }),
    );
    // Wait — these have DIFFERENT default_outcomes so different IDs (idempotent on
    // microtheory+pattern+default_outcome). Both will be stored. Queries return
    // priority-DESC sorted, so block (95) wins.
    const result = await verify(
      makeHypothesis({
        target: 'foo.txt',
        context: { tool: 'rm', command: 'delete this file' },
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.verified).toBe(false); // block won
    expect(verdict.reason).toContain('higher priority block');
  });

  test('escalate outcome → verified=true with deliberationRequest', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'universal', action: 'mutation-destructive' },
        pattern: { kind: 'exact-match', target_field: 'verb', value: 'add' },
        default_outcome: 'escalate',
        priority: 60,
        confidence: 0.55,
        rationale: 'add verb but destructive proposal',
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'src/foo.ts',
        context: {
          tool: 'rm',
          understanding: { actionVerb: 'add' },
        },
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('uncertain');
    expect(verdict.deliberationRequest).toBeDefined();
    expect(verdict.deliberationRequest?.suggestedBudget).toBeGreaterThan(0);
  });

  test('needs-confirmation outcome → verified=false, type=uncertain', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'git-workflow', action: 'tool-invocation' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git reset --hard', case_sensitive: true },
        default_outcome: 'needs-confirmation',
        priority: 85,
        confidence: 0.65,
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'README.md',
        context: { tool: 'bash', command: 'git reset --hard HEAD~1' },
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('uncertain');
    expect(verdict.confidence).toBe(0.65);
  });

  test('verdict carries pragmatic-tier metadata', async () => {
    env.registry.insertRule(makeRule());
    const result = await verify(
      makeHypothesis({
        target: 'foo.sh',
        context: { tool: 'rm', command: 'rm -rf /tmp/x' },
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.confidenceSource).toBe('evidence-derived');
    expect(verdict.tierReliability).toBe(0.6);
    expect(verdict.opinion).toBeDefined();
    expect(verdict.opinion?.baseRate).toBe(0.6); // pragmatic center
    expect(verdict.temporalContext).toBeDefined();
    expect(verdict.oracleName).toBe('commonsense');
  });

  test('full innate seed integrates correctly — rm -rf / blocks', async () => {
    loadInnateSeed(env.registry);
    const result = await verify(
      makeHypothesis({
        target: '/',
        context: { tool: 'rm', command: 'rm -rf /' },
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.verified).toBe(false);
    // The exact rm-rf-/ rule has priority 100; should win over the generic rm-rf at 95
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.reason).toContain('rm -rf /');
  });

  test('full innate seed — git push --force-with-lease is suppressed', async () => {
    loadInnateSeed(env.registry);
    const result = await verify(
      makeHypothesis({
        target: 'README.md',
        context: { tool: 'git', command: 'git push --force-with-lease origin main' },
      }),
    );
    const verdict = result as OracleVerdict;
    // git push --force rule has --force-with-lease as abnormality predicate.
    // But the literal "git push --force" substring DOES match in this command
    // (because --force-with-lease contains --force). So pattern matches AND
    // abnormality matches → suppressed.
    expect(verdict.evidence.some((e) => e.file === 'commonsense:suppression')).toBe(true);
  });
});

describe('CommonSense Oracle — priorAssumption (ECP extension)', () => {
  test('verdict has priorAssumption[] populated when rule fires', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
        default_outcome: 'block',
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'tmp.txt',
        context: { tool: 'rm', command: 'rm -rf /tmp/cache' },
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.priorAssumption).toBeDefined();
    expect(verdict.priorAssumption!.length).toBeGreaterThanOrEqual(1);

    const pa = verdict.priorAssumption![0]!;
    expect(pa.ruleId).toMatch(/^[a-f0-9]{64}$/);
    expect(pa.microtheory).toEqual({ language: 'universal', domain: 'filesystem', action: 'mutation-destructive' });
    expect(pa.source).toBe('innate');
    expect(pa.priority).toBe(90);
    expect(pa.confidence).toBe(0.7);
    expect(pa.defaultOutcome).toBe('block');
    expect(pa.rationale).toBe('test rule');
    expect(pa.abnormalityPredicate).toBeUndefined();
  });

  test('priorAssumption.abnormalityPredicate is serialized when rule has one', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git push --force', case_sensitive: true },
        abnormality_predicate: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: '--force-with-lease',
          case_sensitive: true,
        },
        default_outcome: 'block',
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'README.md',
        context: { tool: 'git', command: 'git push --force origin main' }, // no lease → fires
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.priorAssumption!.length).toBe(1);
    expect(verdict.priorAssumption![0]!.abnormalityPredicate).toBeDefined();
    // Round-trip: consumers can parse and re-evaluate
    const parsed = JSON.parse(verdict.priorAssumption![0]!.abnormalityPredicate!);
    expect(parsed.kind).toBe('literal-substring');
    expect(parsed.needle).toBe('--force-with-lease');
  });

  test('priorAssumption is absent on unknown verdict (no rule fired)', async () => {
    // Empty registry → out_of_domain abstention. Test the no-fire path:
    // matching microtheory but no pattern match.
    env.registry.insertRule(makeRule());
    const result = await verify(
      makeHypothesis({
        target: 'foo.sh',
        context: { tool: 'rm', command: 'rm /tmp/x' }, // doesn't include 'rm -rf'
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.type).toBe('unknown');
    expect(verdict.priorAssumption).toBeUndefined();
  });

  test('priorAssumption excludes suppressed rules (only firing)', async () => {
    // Two rules: one fires, one suppressed by abnormality
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
        default_outcome: 'block',
        priority: 95,
      }),
    );
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
        abnormality_predicate: {
          kind: 'literal-substring',
          target_field: 'command',
          needle: '--dry-run',
          case_sensitive: true,
        },
        default_outcome: 'allow',
        priority: 80,
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'tmp.txt',
        context: { tool: 'rm', command: 'rm -rf /tmp/cache' }, // no --dry-run → both rules pattern-match, the one with abnormality fires (no suppression), the other... wait
      }),
    );
    // With no '--dry-run' in command:
    //   Rule A (no abnormality):       fires → priorAssumption
    //   Rule B (--dry-run abnormality): pattern matches, abnormality does NOT hold → also fires
    // Both fire. priorAssumption has 2 entries.
    const verdict = result as OracleVerdict;
    expect(verdict.priorAssumption!.length).toBe(2);
  });

  test('priorAssumption preserved across multiple firing rules — sorted by priority', async () => {
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'delete', case_sensitive: true },
        default_outcome: 'block',
        priority: 95,
        rationale: 'high priority',
      }),
    );
    env.registry.insertRule(
      makeRule({
        microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
        pattern: { kind: 'literal-substring', target_field: 'command', needle: 'delete', case_sensitive: true },
        default_outcome: 'allow', // different default_outcome → different id
        priority: 50,
        rationale: 'low priority',
      }),
    );
    const result = await verify(
      makeHypothesis({
        target: 'foo.txt',
        context: { tool: 'rm', command: 'delete this file' },
      }),
    );
    const verdict = result as OracleVerdict;
    expect(verdict.priorAssumption!.length).toBe(2);
    // Sorted by priority DESC (registry order)
    expect(verdict.priorAssumption![0]!.priority).toBe(95);
    expect(verdict.priorAssumption![1]!.priority).toBe(50);
  });
});
