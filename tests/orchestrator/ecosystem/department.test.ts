import { describe, expect, it } from 'bun:test';
import {
  DepartmentIndex,
  type DepartmentSeed,
  deriveMembership,
} from '../../../src/orchestrator/ecosystem/department.ts';
import type { ReasoningEngine } from '../../../src/orchestrator/types.ts';

function makeEngine(id: string, capabilities: string[]): Pick<ReasoningEngine, 'id' | 'capabilities'> {
  return { id, capabilities };
}

const DEFAULT_SEEDS: DepartmentSeed[] = [
  { id: 'code', anchorCapabilities: ['code-generation', 'tool-use'], minMatchCount: 2 },
  { id: 'research', anchorCapabilities: ['reasoning', 'text-generation'], minMatchCount: 1 },
  { id: 'verification', anchorCapabilities: ['ast-analysis', 'tool-use'], minMatchCount: 1 },
];

describe('deriveMembership', () => {
  it('includes departments where the engine meets minMatchCount', () => {
    const eng = makeEngine('e1', ['code-generation', 'tool-use', 'reasoning']);
    const m = deriveMembership(eng, DEFAULT_SEEDS.map((s) => ({ ...s, minMatchCount: s.minMatchCount ?? 1 })));
    expect([...m.departmentIds].sort()).toEqual(['code', 'research', 'verification']);
    expect(m.matchedCapabilities['code']).toEqual(['code-generation', 'tool-use']);
  });

  it('excludes departments where minMatchCount is not met', () => {
    // Only one code-anchor capability → below minMatchCount=2
    const eng = makeEngine('e1', ['code-generation', 'reasoning']);
    const m = deriveMembership(eng, DEFAULT_SEEDS.map((s) => ({ ...s, minMatchCount: s.minMatchCount ?? 1 })));
    expect(m.departmentIds).not.toContain('code');
    expect(m.departmentIds).toContain('research'); // reasoning matches
  });

  it('returns empty membership when no anchors match', () => {
    const eng = makeEngine('e1', ['kitchen-sink']);
    const m = deriveMembership(eng, DEFAULT_SEEDS.map((s) => ({ ...s, minMatchCount: s.minMatchCount ?? 1 })));
    expect(m.departmentIds).toEqual([]);
  });
});

describe('DepartmentIndex', () => {
  it('lists configured departments after construction', () => {
    const idx = new DepartmentIndex(DEFAULT_SEEDS);
    const ids = idx.listDepartments().map((d) => d.id);
    expect(ids.sort()).toEqual(['code', 'research', 'verification']);
  });

  it('upsertEngine inserts memberships', () => {
    const idx = new DepartmentIndex(DEFAULT_SEEDS);
    idx.upsertEngine(makeEngine('e1', ['code-generation', 'tool-use']));

    expect([...idx.getDepartmentsOfEngine('e1')].sort()).toEqual(['code', 'verification']);
    expect(idx.getEnginesInDepartment('code')).toContain('e1');
    expect(idx.getEnginesInDepartment('verification')).toContain('e1');
    expect(idx.isMember('e1', 'code')).toBe(true);
    expect(idx.isMember('e1', 'research')).toBe(false);
  });

  it('supports engines in multiple departments', () => {
    const idx = new DepartmentIndex(DEFAULT_SEEDS);
    idx.upsertEngine(makeEngine('multi', ['code-generation', 'tool-use', 'reasoning']));
    expect([...idx.getDepartmentsOfEngine('multi')].sort()).toEqual(['code', 'research', 'verification']);
  });

  it('removeEngine clears all memberships', () => {
    const idx = new DepartmentIndex(DEFAULT_SEEDS);
    idx.upsertEngine(makeEngine('e1', ['code-generation', 'tool-use']));
    idx.removeEngine('e1');

    expect(idx.getDepartmentsOfEngine('e1')).toEqual([]);
    expect(idx.getEnginesInDepartment('code')).not.toContain('e1');
  });

  it('upsertEngine is idempotent — repeated calls replace prior membership', () => {
    const idx = new DepartmentIndex(DEFAULT_SEEDS);
    idx.upsertEngine(makeEngine('e1', ['code-generation', 'tool-use']));
    idx.upsertEngine(makeEngine('e1', ['reasoning']));

    expect(idx.getDepartmentsOfEngine('e1')).toEqual(['research']);
    expect(idx.getEnginesInDepartment('code')).not.toContain('e1');
  });

  it('refresh rebuilds the index from a roster', () => {
    const idx = new DepartmentIndex(DEFAULT_SEEDS);
    idx.upsertEngine(makeEngine('old', ['code-generation', 'tool-use']));
    idx.refresh([
      makeEngine('a', ['reasoning']),
      makeEngine('b', ['tool-use', 'ast-analysis']),
    ]);

    expect(idx.getDepartmentsOfEngine('old')).toEqual([]);
    expect(idx.getDepartmentsOfEngine('a')).toEqual(['research']);
    expect([...idx.getDepartmentsOfEngine('b')].sort()).toEqual(['verification']);
  });

  it('tracks engines that matched zero departments without losing them on remove', () => {
    const idx = new DepartmentIndex(DEFAULT_SEEDS);
    idx.upsertEngine(makeEngine('drifter', ['esoteric-capability']));
    expect(idx.getDepartmentsOfEngine('drifter')).toEqual([]);

    // Remove should still work without throwing
    idx.removeEngine('drifter');
    expect(idx.getDepartmentsOfEngine('drifter')).toEqual([]);
  });
});
