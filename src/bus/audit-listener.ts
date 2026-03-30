/**
 * Audit Listener — appends structured JSONL for all bus events.
 *
 * Best-effort file writes (swallows errors). Provides event-sourced audit trail
 * for post-mortem debugging and future Sleep Cycle queries.
 *
 * Source of truth: vinyan-tdd.md §1C.4
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
  "shadow:enqueue",
  "shadow:complete",
  "shadow:fail",
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
