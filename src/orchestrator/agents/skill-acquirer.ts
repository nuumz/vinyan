/**
 * SkillAcquirer — Phase-5B contract for runtime skill acquisition.
 *
 * Defines the interface that future Phase-6 implementations will satisfy.
 * The contract is intentionally narrow: given a persona and a capability
 * gap, return zero or more `SkillRef`s the caller can attach as
 * acquired-scope skills for the current task.
 *
 * Two anticipated implementations (deferred to Phase 6):
 *   - **HubImportAcquirer**: queries the hub adapter (or local cache),
 *     filters candidates against the persona's `acquirableSkillTags` glob
 *     (`skill-tag-matcher.ts`), passes them through the gate+critic
 *     pipeline, and returns refs for skills that promote to `probation`.
 *   - **AutonomousCreatorAcquirer**: triggers `AutonomousSkillCreator`
 *     with a (persona × task-signature) trigger surface; on draft
 *     promotion, returns a ref to the just-created skill.
 *
 * Both must:
 *   - Honor `acquirableSkillTags` — never return a skill that doesn't
 *     match the persona's tag scope (role-scoping defense).
 *   - Honor A1 — drafting and verification engines must differ
 *     (already enforced inside AutonomousSkillCreator construction).
 *   - Be idempotent — repeated calls for the same gap should not
 *     create duplicate skills; Phase 6 wiring uses content-hash dedupe.
 *
 * The interface is async because acquisition may incur network IO
 * (hub adapter) or LLM calls (autonomous draft generator).
 */
import type { AgentSpec, CapabilityRequirement, SkillRef } from '../types.ts';

export interface SkillAcquirerOptions {
  /** Task identifier for tracing / cleanup. */
  taskId: string;
  /** Optional hint about the routing level so acquirers can budget IO. */
  routingLevel?: number;
}

/**
 * One side of the persona/skill bridge for runtime gap-filling. Implementations
 * decide where the candidate skill comes from (local cache, hub, autonomous
 * draft); the contract is the same: take a gap, return zero or more refs the
 * caller can pass into `getDerivedCapabilities({ extraRefs })`.
 */
export interface SkillAcquirer {
  /**
   * Attempt to find or create a skill that fills the given capability gap
   * for the persona.
   *
   * Returns:
   *   - `[]` — acquirer ran but produced no candidate (offline, no match,
   *     gate rejection). Caller falls back to legacy gap behaviour.
   *   - `[ref, ...]` — refs the caller can pass to the registry. Each ref
   *     must point to a skill already present in the artifact store
   *     (acquirers that need to download write before returning).
   *   - throws — only on programmer errors. IO/network failures must
   *     resolve to `[]` so a flaky hub never breaks task execution (A9).
   */
  acquireForGap(
    persona: AgentSpec,
    gap: CapabilityRequirement,
    options: SkillAcquirerOptions,
  ): Promise<readonly SkillRef[]>;
}

/**
 * Null-object acquirer for environments without skill acquisition wired in.
 * Always returns `[]`. Use as a default so call sites can call
 * `acquirer.acquireForGap(...)` unconditionally without null guards.
 */
export const NullSkillAcquirer: SkillAcquirer = {
  async acquireForGap(): Promise<readonly SkillRef[]> {
    return [];
  },
};
