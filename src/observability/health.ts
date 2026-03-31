/**
 * Health Check — lightweight system health assessment.
 *
 * Source of truth: vinyan-implementation-plan.md §P3.6
 */
import type { OracleCircuitBreaker } from "../oracle/circuit-breaker.ts";

export interface HealthDeps {
  dbPath?: string;
  shadowQueueDepth: number;
  circuitBreaker?: OracleCircuitBreaker;
  /** @deprecated Use circuitBreaker instead */
  circuitBreakerStates?: Record<string, "closed" | "open" | "half-open">;
}

export interface HealthCheck {
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    database: { ok: boolean; sizeMB?: number };
    shadowQueue: { ok: boolean; depth: number };
    circuitBreakers: { ok: boolean; openCount: number };
  };
}

export function getHealthCheck(deps: HealthDeps): HealthCheck {
  let dbSizeMB: number | undefined;
  let dbOk = true;

  if (deps.dbPath) {
    try {
      const stat = Bun.file(deps.dbPath);
      dbSizeMB = stat.size / (1024 * 1024);
    } catch {
      dbOk = false;
    }
  }

  const shadowOk = deps.shadowQueueDepth < 100; // warn if queue grows too large

  // Prefer live circuit breaker over static state map
  const cbStates = deps.circuitBreaker?.getAllStates() ?? deps.circuitBreakerStates ?? {};
  const openBreakers = Object.values(cbStates).filter(s => s === "open").length;
  const cbOk = openBreakers === 0;

  const allOk = dbOk && shadowOk && cbOk;
  const anyFailed = !dbOk;

  return {
    status: anyFailed ? "unhealthy" : allOk ? "healthy" : "degraded",
    checks: {
      database: { ok: dbOk, sizeMB: dbSizeMB },
      shadowQueue: { ok: shadowOk, depth: deps.shadowQueueDepth },
      circuitBreakers: { ok: cbOk, openCount: openBreakers },
    },
  };
}
