/**
 * Capability Analyzer — derive what a task NEEDS, in capability terms.
 *
 * Deterministic-first (A3): the analyzer reads `TaskInput` + `PerceptualHierarchy`
 * + caller-supplied hints and emits `CapabilityRequirement[]`. It NEVER does
 * regex-on-goal classification of agents/roles — semantic role inference is
 * the LLM intent resolver's job, downstream of this layer. Caller-supplied
 * structured hints (capabilities, roles) are forwarded as-is.
 *
 * Reuses `computeFingerprint` so we share the action-verb / file-ext /
 * framework vocabulary with the rest of the orchestrator (no duplicate
 * keyword tables).
 */
import { computeFingerprint } from '../task-fingerprint.ts';
import type { CapabilityRequirement, PerceptualHierarchy, TaskInput } from '../types.ts';

export interface AnalyzerInput {
  task: TaskInput;
  perception?: PerceptualHierarchy;
  /**
   * Pre-computed requirements (e.g. forwarded by the LLM intent resolver
   * after structured extraction). The analyzer trusts these as-is, only
   * normalizing missing `source` fields.
   */
  requirements?: CapabilityRequirement[];
  /**
   * Coarse roles the caller wants the agent to fulfill (e.g. 'editor',
   * 'researcher'). Each becomes a role-typed requirement.
   */
  roles?: string[];
  /** Trace count, used to gate framework-marker dimensions inside fingerprint. */
  traceCount?: number;
}

/** Default weight assignments — kept compatible with the legacy rule scorer
 *  so an exact single-dimension match (e.g. extension-only) still matches
 *  the old 0.4 threshold and ambiguous reasoning tasks still fall through
 *  to `needs-llm`. The action-verb dimension is intentionally weighted low
 *  because verbs alone are weak routing signals — a goal like "test"
 *  against a `.md` file should not pull a TypeScript tester onto the
 *  task. */
const W_FILE_EXTENSIONS = 0.5;
const W_ACTION_VERB = 0.1;
const W_FRAMEWORKS = 0.2;
const W_DOMAIN = 0.2;
const W_ROLE = 0.4;

export function analyzeRequirements(input: AnalyzerInput): CapabilityRequirement[] {
  const { task, perception, requirements, roles, traceCount } = input;
  const out: CapabilityRequirement[] = [];

  // 1. Caller-supplied requirements always carry through. Normalize missing
  //    `source` so downstream consumers can trust the field exists.
  if (requirements) {
    for (const r of requirements) {
      out.push({ ...r, source: r.source ?? 'caller' });
    }
  }

  // 2. Deterministic fingerprint signals.
  const fp = computeFingerprint(task, perception, { traceCount });

  if (fp.fileExtensions.length > 0) {
    out.push({
      id: 'task.file-extensions',
      weight: W_FILE_EXTENSIONS,
      fileExtensions: fp.fileExtensions,
      source: 'fingerprint',
    });
  }

  if (fp.actionVerb && fp.actionVerb !== 'unknown') {
    out.push({
      id: `task.action.${fp.actionVerb}`,
      weight: W_ACTION_VERB,
      actionVerbs: [fp.actionVerb],
      source: 'fingerprint',
    });
  }

  if (fp.frameworkMarkers && fp.frameworkMarkers.length > 0) {
    out.push({
      id: 'task.frameworks',
      weight: W_FRAMEWORKS,
      frameworkMarkers: fp.frameworkMarkers,
      source: 'fingerprint',
    });
  }

  // 3. Coarse domain signal from `taskType`. We mirror agent-router's old
  //    mapping so existing routingHints continue to behave identically.
  const domain =
    task.taskType === 'code' ? (task.targetFiles?.length ? 'code-mutation' : 'code-reasoning') : 'general-reasoning';
  out.push({
    id: `task.domain.${domain}`,
    weight: W_DOMAIN,
    domains: [domain],
    source: 'fingerprint',
  });

  // 4. Caller-supplied roles → explicit role requirement, deduped against
  //    any role already present in `requirements`.
  if (roles) {
    const seen = new Set(out.filter((r) => r.role).map((r) => r.role));
    for (const role of roles) {
      if (seen.has(role)) continue;
      out.push({
        id: `task.role.${role}`,
        weight: W_ROLE,
        role,
        source: 'caller',
      });
      seen.add(role);
    }
  }

  return out;
}
