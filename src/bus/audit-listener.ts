/**
 * Audit Listener — appends structured JSONL for all bus events.
 *
 * Best-effort file writes (swallows errors). Provides event-sourced audit trail
 * for post-mortem debugging and future Sleep Cycle queries.
 *
 * Source of truth: spec/tdd.md §1C.4
 */
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { VinyanBus, BusEventName } from "../core/bus.ts";

const ALL_EVENTS: BusEventName[] = [
  "task:start",
  "task:complete",
  "worker:dispatch",
  "worker:complete",
  "worker:error",
  "oracle:verdict",
  "trace:record",
  "selfmodel:predict",
  "graph:fact",
  "circuit:open",
  "circuit:close",
  "task:escalate",
  "task:timeout",
  "task:explore",
  "shadow:enqueue",
  "shadow:complete",
  "shadow:failed",
  "skill:match",
  "skill:miss",
  "skill:outcome",
  "evolution:rulesApplied",
  "evolution:rulePromoted",
  "evolution:ruleRetired",
  "sleep:cycleComplete",
  "tools:executed",
  // Phase 1 — verification & governance
  "critic:verdict",
  "task:approval_required",
  "commit:rejected",
  // Guardrails
  "guardrail:injection_detected",
  "guardrail:bypass_detected",
  // Self-model & oracle
  "selfmodel:calibration_error",
  "oracle:contradiction",
  // Decomposer
  "decomposer:fallback",
  // Phase 4 — Fleet Governance
  "worker:registered",
  "worker:promoted",
  "worker:demoted",
  "worker:reactivated",
  "worker:selected",
  "worker:exploration",
  "fleet:convergence_warning",
  "fleet:emergency_reactivation",
  "fleet:diversity_enforced",
  "task:uncertain",
];

export function attachAuditListener(
  bus: VinyanBus,
  auditPath: string,
): () => void {
  // Ensure parent directory exists
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
  } catch {
    // Best-effort
  }

  const detachers: Array<() => void> = [];

  for (const event of ALL_EVENTS) {
    detachers.push(bus.on(event, (payload: unknown) => {
      try {
        const line = JSON.stringify({ ts: Date.now(), event, payload });
        appendFileSync(auditPath, line + "\n");
      } catch {
        // Audit is best-effort — never block the core loop
      }
    }));
  }

  return () => {
    for (const detach of detachers) detach();
  };
}
