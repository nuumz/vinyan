/**
 * Adaptive Parameter Store — runtime read/write surface for ceiling
 * parameters.
 *
 * Reads:
 *   1. In-memory override (test injection, operator config snapshot).
 *   2. Latest ledger row (sleep-cycle / operator / autonomous tuner).
 *   3. Registry default.
 *
 * Writes:
 *   - Always go through the ledger (audit-first). The store updates its
 *     in-memory cache and emits a bus event so subscribers re-read.
 *
 * Validation:
 *   - Every write is shape-checked against the registry. Out-of-range
 *     writes are rejected (typed result, no throw on the read path).
 *
 * Axioms upheld:
 *   - A3 — `set()` is rule-based; no LLM in the path.
 *   - A8 — every change is recorded with reason + owner + timestamp.
 *   - A14 (proposed) — sleep-cycle plateau adaptation will use this seam.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { ParameterLedger } from './parameter-ledger.ts';
import {
  getParameterDef,
  listParameterDefs,
  type ParameterDef,
  validateParameterValue,
} from './parameter-registry.ts';

export interface ParameterStoreOptions {
  readonly ledger?: ParameterLedger;
  readonly bus?: VinyanBus;
  /** Test/config-time overrides. Bypass ledger; never persisted. */
  readonly overrides?: ReadonlyMap<string, unknown>;
}

export type ParameterSetResult =
  | { readonly ok: true; readonly oldValue: unknown; readonly newValue: unknown }
  | { readonly ok: false; readonly reason: string };

export class ParameterStore {
  private readonly ledger: ParameterLedger | undefined;
  private readonly bus: VinyanBus | undefined;
  private readonly overrides: Map<string, unknown>;
  /** In-memory cache of the latest applied value per key (lazy-loaded). */
  private readonly cache = new Map<string, unknown>();
  /** Keys we've already loaded from the ledger so we don't repeat the SELECT. */
  private readonly loaded = new Set<string>();

  constructor(opts: ParameterStoreOptions = {}) {
    this.ledger = opts.ledger;
    this.bus = opts.bus;
    this.overrides = new Map(opts.overrides ?? new Map());
  }

  // ── reads ────────────────────────────────────────────────────────────

  getNumber(key: string): number {
    const def = this.requireDef(key, ['number', 'integer', 'duration-ms']);
    const raw = this.resolveValue(def);
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    return def.default as number;
  }

  getInteger(key: string): number {
    return Math.trunc(this.getNumber(key));
  }

  getDurationMs(key: string): number {
    const def = this.requireDef(key, ['duration-ms']);
    const raw = this.resolveValue(def);
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
    return def.default as number;
  }

  getRecord(key: string): Readonly<Record<string, number>> {
    const def = this.requireDef(key, ['number-record']);
    const raw = this.resolveValue(def);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const candidate = raw as Record<string, unknown>;
      const expected = def.default as Readonly<Record<string, number>>;
      const out: Record<string, number> = { ...expected };
      let allOk = true;
      for (const k of Object.keys(expected)) {
        const v = candidate[k];
        if (typeof v === 'number' && Number.isFinite(v)) {
          out[k] = v;
        } else {
          allOk = false;
          break;
        }
      }
      if (allOk) return out;
    }
    return def.default as Readonly<Record<string, number>>;
  }

  /** Inspect the current source for a parameter — useful for diagnostics. */
  describe(key: string): {
    readonly def: ParameterDef;
    readonly currentValue: unknown;
    readonly source: 'override' | 'ledger' | 'default';
  } {
    const def = this.requireDef(key);
    if (this.overrides.has(key)) {
      return { def, currentValue: this.overrides.get(key), source: 'override' };
    }
    this.ensureLoaded(def);
    if (this.cache.has(key)) {
      return { def, currentValue: this.cache.get(key), source: 'ledger' };
    }
    return { def, currentValue: def.default, source: 'default' };
  }

  // ── writes ───────────────────────────────────────────────────────────

  /**
   * Mutate a parameter. Validates against the registry, appends to the
   * ledger if available, updates the cache, emits a bus event.
   *
   * Returns a typed result rather than throwing so callers can surface
   * the rejection reason in their own audit trail.
   */
  set(
    key: string,
    newValue: unknown,
    reason: string,
    ownerModule: string,
  ): ParameterSetResult {
    const def = getParameterDef(key);
    if (!def) return { ok: false, reason: `unknown parameter "${key}"` };
    if (!def.tunable) return { ok: false, reason: `parameter "${key}" is not tunable` };
    const validation = validateParameterValue(def, newValue);
    if (validation.ok !== true) return { ok: false, reason: validation.reason };

    this.ensureLoaded(def);
    const oldValue = this.cache.has(key) ? this.cache.get(key) : def.default;

    if (this.ledger) {
      this.ledger.append({
        paramName: key,
        oldValue,
        newValue,
        reason,
        ownerModule,
      });
    }
    this.cache.set(key, newValue);
    this.loaded.add(key);

    this.bus?.emit('adaptive-params:value_changed', {
      key,
      oldValue,
      newValue,
      reason,
      ownerModule,
      source: this.ledger ? 'ledger' : 'in-memory',
    });

    return { ok: true, oldValue, newValue };
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private requireDef(key: string, expectedTypes?: readonly string[]): ParameterDef {
    const def = getParameterDef(key);
    if (!def) {
      throw new Error(`parameter-store: unknown parameter "${key}". Register it in parameter-registry.ts.`);
    }
    if (expectedTypes && !expectedTypes.includes(def.type)) {
      throw new Error(
        `parameter-store: "${key}" has type "${def.type}", expected one of ${expectedTypes.join(', ')}`,
      );
    }
    return def;
  }

  private resolveValue(def: ParameterDef): unknown {
    if (this.overrides.has(def.key)) return this.overrides.get(def.key);
    this.ensureLoaded(def);
    if (this.cache.has(def.key)) return this.cache.get(def.key);
    return def.default;
  }

  private ensureLoaded(def: ParameterDef): void {
    if (this.loaded.has(def.key)) return;
    this.loaded.add(def.key);
    if (!this.ledger) return;
    const latest = this.ledger.latest(def.key);
    if (!latest) return;
    // Ledger value may be stale relative to current registry shape. Validate
    // before caching; on mismatch fall back to default and log.
    const validation = validateParameterValue(def, latest.newValue);
    if (validation.ok === true) {
      this.cache.set(def.key, latest.newValue);
    } else {
      console.warn(
        `[parameter-store] ledger value for "${def.key}" failed validation (${validation.reason}); falling back to default`,
      );
    }
  }

  /** Return a snapshot of every registered parameter with its current value. */
  snapshot(): Array<{ key: string; def: ParameterDef; currentValue: unknown; source: 'override' | 'ledger' | 'default' }> {
    return listParameterDefs().map((def) => {
      const d = this.describe(def.key);
      return { key: def.key, def, currentValue: d.currentValue, source: d.source };
    });
  }
}
