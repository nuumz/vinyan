import { describe, test, expect } from "bun:test";
import {
  WorkingMemory,
  MAX_FAILED_APPROACHES,
  MAX_HYPOTHESES,
  MAX_UNCERTAINTIES,
  MAX_SCOPED_FACTS,
} from "../../src/orchestrator/working-memory.ts";

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

  // ── Bounded eviction tests ─────────────────────────────────────────────────

  test(`failedApproaches: FIFO eviction at cap (MAX=${MAX_FAILED_APPROACHES})`, () => {
    const wm = new WorkingMemory();
    for (let i = 0; i < MAX_FAILED_APPROACHES; i++) {
      wm.recordFailedApproach(`approach-${i}`, `verdict-${i}`);
    }
    expect(wm.getSnapshot().failedApproaches).toHaveLength(MAX_FAILED_APPROACHES);

    // Adding the 21st entry evicts approach-0 (oldest)
    wm.recordFailedApproach("approach-new", "verdict-new");
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches).toHaveLength(MAX_FAILED_APPROACHES);
    expect(snap.failedApproaches[0]!.approach).toBe("approach-1");
    expect(snap.failedApproaches[MAX_FAILED_APPROACHES - 1]!.approach).toBe("approach-new");
  });

  test(`activeHypotheses: evicts lowest confidence at cap (MAX=${MAX_HYPOTHESES})`, () => {
    const wm = new WorkingMemory();
    // Fill with confidences 0.1 through 1.0
    for (let i = 0; i < MAX_HYPOTHESES; i++) {
      wm.addHypothesis(`hypothesis-${i}`, (i + 1) * 0.1, "llm");
    }
    expect(wm.getSnapshot().activeHypotheses).toHaveLength(MAX_HYPOTHESES);

    // hypothesis-0 has confidence 0.1 — should be evicted
    wm.addHypothesis("hypothesis-new", 0.95, "llm");
    const snap = wm.getSnapshot();
    expect(snap.activeHypotheses).toHaveLength(MAX_HYPOTHESES);
    const names = snap.activeHypotheses.map(h => h.hypothesis);
    expect(names).not.toContain("hypothesis-0");
    expect(names).toContain("hypothesis-new");
  });

  test(`unresolvedUncertainties: FIFO eviction at cap (MAX=${MAX_UNCERTAINTIES})`, () => {
    const wm = new WorkingMemory();
    for (let i = 0; i < MAX_UNCERTAINTIES; i++) {
      wm.addUncertainty(`area-${i}`, 0.5, "investigate");
    }
    expect(wm.getSnapshot().unresolvedUncertainties).toHaveLength(MAX_UNCERTAINTIES);

    // Adding the 11th entry evicts area-0 (oldest)
    wm.addUncertainty("area-new", 0.3, "retry");
    const snap = wm.getSnapshot();
    expect(snap.unresolvedUncertainties).toHaveLength(MAX_UNCERTAINTIES);
    expect(snap.unresolvedUncertainties[0]!.area).toBe("area-1");
    expect(snap.unresolvedUncertainties[MAX_UNCERTAINTIES - 1]!.area).toBe("area-new");
  });

  test(`scopedFacts: FIFO eviction at cap (MAX=${MAX_SCOPED_FACTS})`, () => {
    const wm = new WorkingMemory();
    for (let i = 0; i < MAX_SCOPED_FACTS; i++) {
      wm.addScopedFact(`src/file-${i}.ts`, "*.ts", true, `hash-${i}`);
    }
    expect(wm.getSnapshot().scopedFacts).toHaveLength(MAX_SCOPED_FACTS);

    // Adding the 51st entry evicts file-0 (oldest)
    wm.addScopedFact("src/file-new.ts", "*.ts", false, "hash-new");
    const snap = wm.getSnapshot();
    expect(snap.scopedFacts).toHaveLength(MAX_SCOPED_FACTS);
    expect(snap.scopedFacts[0]!.target).toBe("src/file-1.ts");
    expect(snap.scopedFacts[MAX_SCOPED_FACTS - 1]!.target).toBe("src/file-new.ts");
  });

  test("confidence-based eviction always keeps higher confidence hypotheses", () => {
    const wm = new WorkingMemory();
    // Add 9 high-confidence hypotheses and 1 low-confidence
    for (let i = 0; i < 9; i++) {
      wm.addHypothesis(`high-${i}`, 0.9, "llm");
    }
    wm.addHypothesis("low-conf", 0.1, "llm");
    expect(wm.getSnapshot().activeHypotheses).toHaveLength(MAX_HYPOTHESES);

    // Adding another high-confidence entry must evict "low-conf"
    wm.addHypothesis("newer-high", 0.85, "llm");
    const snap = wm.getSnapshot();
    const names = snap.activeHypotheses.map(h => h.hypothesis);
    expect(names).not.toContain("low-conf");
    expect(names).toContain("newer-high");
    snap.activeHypotheses.forEach(h => expect(h.confidence).toBeGreaterThanOrEqual(0.85));
  });

  test("getSnapshot returns deep copy — field mutation does not affect internal state", () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach("original", "oracle-rejected");

    const snap1 = wm.getSnapshot();
    snap1.failedApproaches[0]!.approach = "mutated";
    snap1.failedApproaches.push({ approach: "injected", oracleVerdict: "none", timestamp: 0 });

    const snap2 = wm.getSnapshot();
    expect(snap2.failedApproaches).toHaveLength(1);
    expect(snap2.failedApproaches[0]!.approach).toBe("original");
  });
});
