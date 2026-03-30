import { describe, test, expect } from "bun:test";
import { WorkingMemory } from "../../src/orchestrator/working-memory.ts";

describe("WorkingMemory", () => {
  test("recordFailedApproach adds to snapshot", () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach("inline function", "type: TS2322 type mismatch");
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches).toHaveLength(1);
    expect(snap.failedApproaches[0]!.approach).toBe("inline function");
    expect(snap.failedApproaches[0]!.oracleVerdict).toBe("type: TS2322 type mismatch");
    expect(snap.failedApproaches[0]!.timestamp).toBeGreaterThan(0);
  });

  test("addHypothesis adds to snapshot", () => {
    const wm = new WorkingMemory();
    wm.addHypothesis("extract to utility", 0.7, "self-model");
    const snap = wm.getSnapshot();
    expect(snap.activeHypotheses).toHaveLength(1);
    expect(snap.activeHypotheses[0]!.hypothesis).toBe("extract to utility");
    expect(snap.activeHypotheses[0]!.confidence).toBe(0.7);
  });

  test("addUncertainty adds to snapshot", () => {
    const wm = new WorkingMemory();
    wm.addUncertainty("test coverage", 0.3, "run tests first");
    const snap = wm.getSnapshot();
    expect(snap.unresolvedUncertainties).toHaveLength(1);
    expect(snap.unresolvedUncertainties[0]!.area).toBe("test coverage");
  });

  test("addScopedFact adds to snapshot", () => {
    const wm = new WorkingMemory();
    wm.addScopedFact("src/foo.ts", "type-check", true, "abc123");
    const snap = wm.getSnapshot();
    expect(snap.scopedFacts).toHaveLength(1);
    expect(snap.scopedFacts[0]!.verified).toBe(true);
  });

  test("getSnapshot returns deep copy (mutation safety)", () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach("approach A", "failed");
    const snap1 = wm.getSnapshot();
    snap1.failedApproaches.push({ approach: "mutated", oracleVerdict: "x", timestamp: 0 });
    const snap2 = wm.getSnapshot();
    expect(snap2.failedApproaches).toHaveLength(1); // original unaffected
  });

  test("multiple failed approaches accumulate in order", () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach("approach A", "reason A");
    wm.recordFailedApproach("approach B", "reason B");
    wm.recordFailedApproach("approach C", "reason C");
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches).toHaveLength(3);
    expect(snap.failedApproaches[0]!.approach).toBe("approach A");
    expect(snap.failedApproaches[2]!.approach).toBe("approach C");
  });
});
