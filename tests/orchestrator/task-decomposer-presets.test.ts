/**
 * Book-integration Wave 1.2: Research-Swarm preset tests.
 */
import { describe, expect, test } from 'bun:test';
import { allCriteriaMet, validateDAG } from '../../src/orchestrator/dag-validator.ts';
import {
  buildResearchSwarmDAG,
  DEFAULT_RESEARCH_SWARM_FANOUT,
  matchDecomposerPreset,
  RESEARCH_SWARM_REPORT_CONTRACT,
} from '../../src/orchestrator/task-decomposer-presets.ts';
import type { PerceptualHierarchy, TaskInput } from '../../src/orchestrator/types.ts';

function input(goal: string, taskType: TaskInput['taskType'] = 'reasoning'): TaskInput {
  return {
    id: 'task-x',
    source: 'cli',
    goal,
    taskType,
    targetFiles: [],
    budget: { maxTokens: 10000, maxRetries: 3, maxDurationMs: 60000 },
  };
}

function perception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'investigate' },
    dependencyCone: {
      directImporters: [],
      directImportees: [],
      transitiveBlastRadius: 0,
    },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: '18.0.0', os: 'darwin', availableTools: [] },
  };
}

describe('matchDecomposerPreset — research swarm trigger', () => {
  test('fires on "research <topic>" reasoning task', () => {
    const match = matchDecomposerPreset(input('research the existing auth flow'));
    expect(match?.kind).toBe('research-swarm');
  });

  test('fires on "investigate ..." / "audit ..." / "survey ..."', () => {
    expect(matchDecomposerPreset(input('investigate the cache layer'))?.kind).toBe('research-swarm');
    expect(matchDecomposerPreset(input('audit the error handling pipeline'))?.kind).toBe('research-swarm');
    expect(matchDecomposerPreset(input('survey recent task decomposers'))?.kind).toBe('research-swarm');
  });

  test('does NOT fire on mutation tasks', () => {
    const match = matchDecomposerPreset(input('research how to fix the bug', 'reasoning'));
    // goal contains "fix" → explicitly rejected
    expect(match).toBeNull();
  });

  test('does NOT fire on code tasks regardless of verb', () => {
    const match = matchDecomposerPreset(input('research the refactor target', 'code'));
    expect(match).toBeNull();
  });

  test('does NOT fire when verb is buried past 80 chars', () => {
    const padding = 'x'.repeat(85);
    const longPrefix = `${padding} please research the auth module`;
    const match = matchDecomposerPreset(input(longPrefix));
    expect(match).toBeNull();
  });
});

describe('buildResearchSwarmDAG — structural contract', () => {
  test('default fanout produces N explorers + 1 aggregator', () => {
    const dag = buildResearchSwarmDAG(input('investigate X'), perception());
    expect(dag.nodes).toHaveLength(DEFAULT_RESEARCH_SWARM_FANOUT + 1);
    const explorers = dag.nodes.filter((n) => n.id.startsWith('e'));
    const agg = dag.nodes.find((n) => n.id === 'aggregate');
    expect(explorers.length).toBe(DEFAULT_RESEARCH_SWARM_FANOUT);
    expect(agg).toBeDefined();
    expect(agg!.dependencies.sort()).toEqual(explorers.map((e) => e.id).sort());
  });

  test('passes DAG validator (no orphans, coverage, no overlap)', () => {
    const dag = buildResearchSwarmDAG(input('investigate X'), perception());
    const criteria = validateDAG(dag, []); // empty blast radius → coverage trivially met
    expect(allCriteriaMet(criteria)).toBe(true);
  });

  test('aggregator covers blast radius from perception', () => {
    const perc = perception();
    perc.dependencyCone.directImportees = ['src/a.ts', 'src/b.ts'];
    const dag = buildResearchSwarmDAG(input('investigate X'), perc);
    const agg = dag.nodes.find((n) => n.id === 'aggregate')!;
    expect(agg.targetFiles).toContain('src/a.ts');
    expect(agg.targetFiles).toContain('src/b.ts');
    // Explorers must have empty file sets to avoid scope overlap
    for (const explorer of dag.nodes.filter((n) => n.id.startsWith('e'))) {
      expect(explorer.targetFiles).toHaveLength(0);
    }
  });

  test('fanout is capped at 5', () => {
    const dag = buildResearchSwarmDAG(input('investigate X'), perception(), { fanout: 99 });
    const explorers = dag.nodes.filter((n) => n.id.startsWith('e'));
    expect(explorers.length).toBeLessThanOrEqual(5);
  });

  test('fanout cannot go below 1', () => {
    const dag = buildResearchSwarmDAG(input('investigate X'), perception(), { fanout: 0 });
    const explorers = dag.nodes.filter((n) => n.id.startsWith('e'));
    expect(explorers.length).toBe(1);
  });

  test('report contract constant is stable enough to reference in prompts', () => {
    expect(RESEARCH_SWARM_REPORT_CONTRACT).toContain('REPORT_CONTRACT');
    expect(RESEARCH_SWARM_REPORT_CONTRACT).toContain('## Findings');
    expect(RESEARCH_SWARM_REPORT_CONTRACT).toContain('## Sources');
    expect(RESEARCH_SWARM_REPORT_CONTRACT).toContain('## Open Questions');
  });
});
