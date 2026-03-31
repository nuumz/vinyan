import { describe, test, expect } from "bun:test";
import type { VinyanBusEvents } from "../../src/core/bus.ts";

// Import the ALL_EVENTS array via a re-export trick — audit-listener only exports
// attachAuditListener, but we need ALL_EVENTS for coverage checking.
// We dynamically read the source to extract the array, then compare against the type.

// The canonical way: extract all keys from VinyanBusEvents at the type level,
// then verify ALL_EVENTS covers every key at runtime.

// Helper: get all event names from VinyanBusEvents type via a typed object.
// TypeScript erases interfaces at runtime, so we build the reference set manually
// from the interface definition keys.
const ALL_BUS_EVENT_NAMES: Array<keyof VinyanBusEvents> = [
  "task:start",
  "task:complete",
  "worker:dispatch",
  "oracle:verdict",
  "critic:verdict",
  "trace:record",
  "worker:complete",
  "worker:error",
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
  "selfmodel:predict",
  "graph:fact",
  "circuit:open",
  "circuit:close",
  "tools:executed",
  "task:escalate",
  "task:timeout",
  "task:approval_required",
  "task:explore",
  "guardrail:injection_detected",
  "guardrail:bypass_detected",
  "selfmodel:calibration_error",
  "oracle:contradiction",
  "decomposer:fallback",
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
  "commit:rejected",
];

describe("audit-listener ALL_EVENTS coverage", () => {
  test("ALL_EVENTS includes every key from VinyanBusEvents", async () => {
    // Dynamically import the module to get ALL_EVENTS from the source file
    const { readFileSync } = await import("fs");
    const source = readFileSync(
      new URL("../../src/bus/audit-listener.ts", import.meta.url).pathname,
      "utf-8",
    );

    // Extract the ALL_EVENTS array contents from source
    const match = source.match(/ALL_EVENTS:\s*BusEventName\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();

    const arrayContent = match![1]!;
    // Extract all quoted strings
    const eventNames = [...arrayContent.matchAll(/"([^"]+)"/g)].map(m => m[1]!);

    const auditSet = new Set(eventNames);

    // Every event in VinyanBusEvents should be in ALL_EVENTS
    const missing: string[] = [];
    for (const eventName of ALL_BUS_EVENT_NAMES) {
      if (!auditSet.has(eventName)) {
        missing.push(eventName);
      }
    }

    expect(missing).toEqual([]);
  });

  test("ALL_BUS_EVENT_NAMES list is type-checked against VinyanBusEvents", () => {
    // This test ensures our reference list compiles — if VinyanBusEvents adds
    // a new key, TypeScript will NOT catch it automatically (we'd need a mapped type).
    // But the names are typed as keyof VinyanBusEvents, so any TYPO will be caught.
    expect(ALL_BUS_EVENT_NAMES.length).toBeGreaterThan(0);

    // Verify no duplicates in reference list
    const unique = new Set(ALL_BUS_EVENT_NAMES);
    expect(unique.size).toBe(ALL_BUS_EVENT_NAMES.length);
  });
});
