/**
 * Department — capability-anchored engine grouping for routing locality.
 *
 * A department is a logical cluster of engines that share a capability
 * profile (e.g. "code", "research", "verification"). An engine is a
 * member of a department if at least `minMatchCount` of its declared
 * capabilities appear in the department's `anchorCapabilities` list.
 *
 * This is *emergent* — there is no authority that assigns engines to
 * departments. Adding a new capability-enabled engine automatically
 * updates its memberships when the index is refreshed. Operators seed
 * departments in `vinyan.json` under `ecosystem.departments`.
 *
 * An engine can belong to multiple departments (analysis engine that
 * covers both "research" and "verification", for example).
 *
 * A3: membership is a pure function of the config + engine capability
 * vector — no LLM, no trust signals.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §2.2, §3.1
 */

import type { ReasoningEngine } from '../types.ts';

// ── Types ────────────────────────────────────────────────────────────

export interface DepartmentSeed {
  /** Stable department id (e.g. 'code', 'research', 'verification'). */
  readonly id: string;
  /** Capability strings that define membership. Matched against `ReasoningEngine.capabilities`. */
  readonly anchorCapabilities: readonly string[];
  /**
   * Minimum number of anchor capabilities the engine must declare to be a
   * member. Default 1 = any overlap. Higher = stricter membership.
   */
  readonly minMatchCount?: number;
}

export interface Department extends DepartmentSeed {
  readonly minMatchCount: number;
}

export interface DepartmentMembership {
  readonly engineId: string;
  readonly departmentIds: readonly string[];
  readonly matchedCapabilities: Readonly<Record<string, readonly string[]>>;
}

// ── Pure membership derivation ───────────────────────────────────────

/** Normalize seeds — fill in default minMatchCount. */
export function normalizeSeeds(seeds: readonly DepartmentSeed[]): Department[] {
  return seeds.map((s) => ({
    ...s,
    minMatchCount: s.minMatchCount ?? 1,
  }));
}

/**
 * Compute membership for a single engine. Returns the list of department
 * IDs the engine belongs to, plus which anchor capabilities matched for
 * each. Pure function — no I/O.
 */
export function deriveMembership(
  engine: Pick<ReasoningEngine, 'id' | 'capabilities'>,
  departments: readonly Department[],
): DepartmentMembership {
  const engineCaps = new Set(engine.capabilities);
  const matched: Record<string, readonly string[]> = {};
  const ids: string[] = [];

  for (const dept of departments) {
    const hits = dept.anchorCapabilities.filter((c) => engineCaps.has(c));
    if (hits.length >= dept.minMatchCount) {
      ids.push(dept.id);
      matched[dept.id] = hits;
    }
  }

  return {
    engineId: engine.id,
    departmentIds: ids,
    matchedCapabilities: matched,
  };
}

// ── Index ────────────────────────────────────────────────────────────

/**
 * In-memory department membership index. Rebuilt whenever the engine
 * roster or department seeds change. Queries are O(1) for both
 * `getEnginesInDepartment` and `getDepartmentsOfEngine`.
 *
 * The index is NOT persisted — it's derived state. Departments and
 * engines are the sources of truth.
 */
export class DepartmentIndex {
  private readonly departments: Map<string, Department>;
  private engineDepartments = new Map<string, Set<string>>();
  private departmentEngines = new Map<string, Set<string>>();

  constructor(seeds: readonly DepartmentSeed[]) {
    const normalized = normalizeSeeds(seeds);
    this.departments = new Map(normalized.map((d) => [d.id, d]));
    for (const d of normalized) {
      this.departmentEngines.set(d.id, new Set());
    }
  }

  // ── Reads ────────────────────────────────────────────────────────

  listDepartments(): readonly Department[] {
    return [...this.departments.values()];
  }

  getDepartment(id: string): Department | null {
    return this.departments.get(id) ?? null;
  }

  /** Department IDs the engine is a member of. Empty if no matches. */
  getDepartmentsOfEngine(engineId: string): readonly string[] {
    return [...(this.engineDepartments.get(engineId) ?? [])];
  }

  /** Engine IDs that are members of a department. Empty set for unknown departments. */
  getEnginesInDepartment(departmentId: string): readonly string[] {
    return [...(this.departmentEngines.get(departmentId) ?? [])];
  }

  /** True if `engineId` is in `departmentId`. */
  isMember(engineId: string, departmentId: string): boolean {
    return this.engineDepartments.get(engineId)?.has(departmentId) ?? false;
  }

  // ── Updates ──────────────────────────────────────────────────────

  /**
   * Recompute memberships for a single engine. Call when the engine is
   * registered or its declared capabilities change.
   */
  upsertEngine(engine: Pick<ReasoningEngine, 'id' | 'capabilities'>): DepartmentMembership {
    this.removeEngine(engine.id);
    const membership = deriveMembership(engine, [...this.departments.values()]);
    if (membership.departmentIds.length === 0) {
      // Still track the engine as "known but unassigned" so removeEngine
      // later knows about it. Don't add to any department.
      this.engineDepartments.set(engine.id, new Set());
      return membership;
    }
    this.engineDepartments.set(engine.id, new Set(membership.departmentIds));
    for (const deptId of membership.departmentIds) {
      this.departmentEngines.get(deptId)!.add(engine.id);
    }
    return membership;
  }

  /** Forget an engine (deregistration, retirement). */
  removeEngine(engineId: string): void {
    const depts = this.engineDepartments.get(engineId);
    if (!depts) return;
    for (const deptId of depts) {
      this.departmentEngines.get(deptId)?.delete(engineId);
    }
    this.engineDepartments.delete(engineId);
  }

  /**
   * Bulk refresh — the usual pattern when rebuilding the index from the
   * engine registry. Preserves departments; re-derives memberships for
   * every engine passed in, and drops any engine not in the new list.
   */
  refresh(engines: readonly Pick<ReasoningEngine, 'id' | 'capabilities'>[]): void {
    this.engineDepartments.clear();
    for (const set of this.departmentEngines.values()) set.clear();
    for (const e of engines) this.upsertEngine(e);
  }
}
