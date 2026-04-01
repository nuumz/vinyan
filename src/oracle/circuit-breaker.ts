/**
 * Oracle Circuit Breaker — protects gate from cascading oracle failures.
 *
 * State machine per oracle:
 *   closed → (N failures) → open → (reset timer) → half-open → success → closed
 *                                                             → failure → open
 *
 * TDD §4: failureThreshold=3, resetTimeout=60s.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
};

/**
 * Thread-safety: Safe under Bun's single-threaded event loop. Read-modify-write
 * patterns (failureCount++) complete within a single synchronous block.
 * If Bun Workers (threads) are introduced in Phase 3, move to per-worker
 * instances or use Atomics.
 */
export class OracleCircuitBreaker {
  private circuits = new Map<string, CircuitEntry>();
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Returns true if the oracle should be skipped (circuit open). */
  shouldSkip(oracleName: string, now: number = Date.now()): boolean {
    const entry = this.circuits.get(oracleName);
    if (!entry) return false;

    if (entry.state === 'open') {
      // Check if reset timer has elapsed → transition to half-open
      if (now - entry.lastFailureAt >= this.config.resetTimeoutMs) {
        entry.state = 'half-open';
        return false; // allow one probe
      }
      return true; // still open
    }

    return false; // closed or half-open → allow
  }

  /** Record a successful oracle call. Resets circuit to closed. */
  recordSuccess(oracleName: string): void {
    const entry = this.circuits.get(oracleName);
    if (entry) {
      entry.state = 'closed';
      entry.failureCount = 0;
    }
  }

  /** Record a failed oracle call. May trip circuit to open. */
  recordFailure(oracleName: string, now: number = Date.now()): void {
    let entry = this.circuits.get(oracleName);
    if (!entry) {
      entry = { state: 'closed', failureCount: 0, lastFailureAt: 0 };
      this.circuits.set(oracleName, entry);
    }

    entry.failureCount++;
    entry.lastFailureAt = now;

    if (entry.state === 'half-open') {
      // Probe failed → back to open
      entry.state = 'open';
    } else if (entry.failureCount >= this.config.failureThreshold) {
      entry.state = 'open';
    }
  }

  /** Get current circuit state for an oracle. */
  getState(oracleName: string): CircuitState {
    return this.circuits.get(oracleName)?.state ?? 'closed';
  }

  /** Get all circuit states — used by health check. */
  getAllStates(): Record<string, CircuitState> {
    const result: Record<string, CircuitState> = {};
    for (const [name, entry] of this.circuits) {
      result[name] = entry.state;
    }
    return result;
  }
}
