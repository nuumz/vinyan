import { describe, test, expect } from "bun:test";
import { OracleCircuitBreaker } from "../../src/oracle/circuit-breaker.ts";

describe("OracleCircuitBreaker", () => {
  test("new oracle starts closed", () => {
    const cb = new OracleCircuitBreaker();
    expect(cb.getState("ast")).toBe("closed");
    expect(cb.shouldSkip("ast")).toBe(false);
  });

  test("1-2 failures keep circuit closed", () => {
    const cb = new OracleCircuitBreaker();
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    expect(cb.getState("ast")).toBe("closed");
    expect(cb.shouldSkip("ast")).toBe(false);
  });

  test("3 failures trip circuit to open", () => {
    const cb = new OracleCircuitBreaker();
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    expect(cb.getState("ast")).toBe("open");
    expect(cb.shouldSkip("ast")).toBe(true);
  });

  test("open circuit transitions to half-open after reset timer", () => {
    const cb = new OracleCircuitBreaker({ resetTimeout_ms: 100 });
    const now = 1000;

    cb.recordFailure("ast", now);
    cb.recordFailure("ast", now);
    cb.recordFailure("ast", now);
    expect(cb.getState("ast")).toBe("open");

    // Before timer: still open
    expect(cb.shouldSkip("ast", now + 50)).toBe(true);

    // After timer: transitions to half-open, allows probe
    expect(cb.shouldSkip("ast", now + 100)).toBe(false);
    expect(cb.getState("ast")).toBe("half-open");
  });

  test("half-open + success → closed", () => {
    const cb = new OracleCircuitBreaker({ resetTimeout_ms: 100 });
    const now = 1000;

    cb.recordFailure("ast", now);
    cb.recordFailure("ast", now);
    cb.recordFailure("ast", now);

    // Trigger half-open
    cb.shouldSkip("ast", now + 100);
    expect(cb.getState("ast")).toBe("half-open");

    // Probe succeeds
    cb.recordSuccess("ast");
    expect(cb.getState("ast")).toBe("closed");
    expect(cb.shouldSkip("ast")).toBe(false);
  });

  test("half-open + failure → back to open", () => {
    const cb = new OracleCircuitBreaker({ resetTimeout_ms: 100 });
    const now = 1000;

    cb.recordFailure("ast", now);
    cb.recordFailure("ast", now);
    cb.recordFailure("ast", now);

    // Trigger half-open
    cb.shouldSkip("ast", now + 100);

    // Probe fails
    cb.recordFailure("ast", now + 101);
    expect(cb.getState("ast")).toBe("open");
    expect(cb.shouldSkip("ast", now + 101)).toBe(true);
  });

  test("success resets failure count", () => {
    const cb = new OracleCircuitBreaker();
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    cb.recordSuccess("ast"); // reset
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    // Only 2 failures since reset — still closed
    expect(cb.getState("ast")).toBe("closed");
  });

  test("circuits are independent per oracle", () => {
    const cb = new OracleCircuitBreaker();
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    expect(cb.getState("ast")).toBe("open");
    expect(cb.getState("type")).toBe("closed");
    expect(cb.shouldSkip("type")).toBe(false);
  });

  test("custom threshold", () => {
    const cb = new OracleCircuitBreaker({ failureThreshold: 5 });
    for (let i = 0; i < 4; i++) cb.recordFailure("ast");
    expect(cb.getState("ast")).toBe("closed");
    cb.recordFailure("ast");
    expect(cb.getState("ast")).toBe("open");
  });
});
