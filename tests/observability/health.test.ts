import { describe, test, expect } from "bun:test";
import { getHealthCheck } from "../../src/observability/health.ts";
import { OracleCircuitBreaker } from "../../src/oracle/circuit-breaker.ts";

describe("getHealthCheck", () => {
  test("live circuitBreaker with open circuit reports degraded and openCount > 0", () => {
    const cb = new OracleCircuitBreaker();
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    cb.recordFailure("ast"); // trips to open

    const result = getHealthCheck({
      shadowQueueDepth: 0,
      circuitBreaker: cb,
    });

    expect(result.status).toBe("degraded");
    expect(result.checks.circuitBreakers.ok).toBe(false);
    expect(result.checks.circuitBreakers.openCount).toBeGreaterThan(0);
  });

  test("all circuits closed reports healthy", () => {
    const cb = new OracleCircuitBreaker();
    cb.recordFailure("ast");
    cb.recordFailure("ast");
    // Only 2 failures — still closed

    const result = getHealthCheck({
      shadowQueueDepth: 0,
      circuitBreaker: cb,
    });

    expect(result.status).toBe("healthy");
    expect(result.checks.circuitBreakers.ok).toBe(true);
    expect(result.checks.circuitBreakers.openCount).toBe(0);
  });

  test("legacy circuitBreakerStates map still works", () => {
    const result = getHealthCheck({
      shadowQueueDepth: 5,
      circuitBreakerStates: {
        ast: "open",
        type: "closed",
        dep: "closed",
      },
    });

    expect(result.status).toBe("degraded");
    expect(result.checks.circuitBreakers.ok).toBe(false);
    expect(result.checks.circuitBreakers.openCount).toBe(1);
  });

  test("no circuit breaker provided defaults to healthy circuit state", () => {
    const result = getHealthCheck({
      shadowQueueDepth: 0,
    });

    expect(result.status).toBe("healthy");
    expect(result.checks.circuitBreakers.ok).toBe(true);
    expect(result.checks.circuitBreakers.openCount).toBe(0);
  });

  test("live circuitBreaker takes precedence over legacy map", () => {
    const cb = new OracleCircuitBreaker();
    // cb has no open circuits

    const result = getHealthCheck({
      shadowQueueDepth: 0,
      circuitBreaker: cb,
      // Legacy map claims ast is open — should be ignored
      circuitBreakerStates: { ast: "open" },
    });

    // cb.getAllStates() returns {} (no failures recorded) → healthy
    expect(result.status).toBe("healthy");
    expect(result.checks.circuitBreakers.openCount).toBe(0);
  });

  test("multiple open circuits all counted in openCount", () => {
    const cb = new OracleCircuitBreaker();
    for (const oracle of ["ast", "type", "dep"]) {
      cb.recordFailure(oracle);
      cb.recordFailure(oracle);
      cb.recordFailure(oracle);
    }

    const result = getHealthCheck({
      shadowQueueDepth: 0,
      circuitBreaker: cb,
    });

    expect(result.checks.circuitBreakers.openCount).toBe(3);
    expect(result.checks.circuitBreakers.ok).toBe(false);
  });
});
