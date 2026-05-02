/**
 * Public builder API — `formatForSpecialist(req, registry)` is what the
 * workflow executor (Phase A wiring) calls after collaboration synthesis
 * resolves. It looks up the adapter on the registry and runs the format
 * transform.
 *
 * Behaviour on registry miss:
 *   - When the requested specialist id does not exist, falls back to
 *     `manual-edit-spec` (the universal default). This keeps the flow
 *     producing useful output even if `intentResolution.specialistTarget`
 *     names a specialist that has been removed or renamed.
 *
 * The fallback is logged via the optional `bus` parameter so dashboards
 * can detect drift between IntentResolver picks and the registry.
 *
 * No I/O — pure dispatch + adapter call.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { SpecialistRegistry } from './registry.ts';
import type { SpecialistFormatRequest, SpecialistFormatResponse, SpecialistId } from './types.ts';

const FALLBACK_SPECIALIST_ID = 'manual-edit-spec';

export interface FormatForSpecialistOptions {
  /** Optional bus for diagnostic events on registry miss / fallback. */
  bus?: VinyanBus;
  /** When true, errors thrown by the adapter propagate. Default false (returns the fallback). */
  rethrow?: boolean;
}

export interface FormatResult extends SpecialistFormatResponse {
  /** The specialist id that ultimately served the request — may be the fallback. */
  resolvedSpecialistId: SpecialistId;
  /** True when the fallback path served instead of the requested id. */
  fellBack: boolean;
}

export function formatForSpecialist(
  requestedId: SpecialistId | undefined,
  req: SpecialistFormatRequest,
  registry: SpecialistRegistry,
  opts: FormatForSpecialistOptions = {},
): FormatResult {
  const targetId = requestedId ?? FALLBACK_SPECIALIST_ID;
  const def = registry.get(targetId);
  const adapter = registry.getAdapter(targetId);

  if (def && adapter) {
    // Merge the specialist's declared `defaultParameters` UNDER the
    // request's parameters — request wins, defaults fill gaps.
    const merged = mergeParameters(def.defaultParameters, req.parameters);
    try {
      const response = adapter({ ...req, parameters: merged });
      return { ...response, resolvedSpecialistId: def.id, fellBack: false };
    } catch (err) {
      if (opts.rethrow) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      opts.bus?.emit(
        'specialist:adapter_failed' as never,
        {
          requestedId: targetId,
          reason,
        } as never,
      );
      return runFallback(req, registry, targetId, `adapter threw: ${reason}`, opts.bus);
    }
  }

  return runFallback(
    req,
    registry,
    targetId,
    requestedId ? `specialist id "${requestedId}" not found in registry` : 'no specialist requested',
    opts.bus,
  );
}

function runFallback(
  req: SpecialistFormatRequest,
  registry: SpecialistRegistry,
  requestedId: SpecialistId,
  reason: string,
  bus: VinyanBus | undefined,
): FormatResult {
  const fallbackAdapter = registry.getAdapter(FALLBACK_SPECIALIST_ID);
  if (!fallbackAdapter) {
    // The fallback adapter is a hard requirement (declared in
    // BUILTIN_SPECIALISTS). If it's missing, the registry is corrupt.
    throw new Error(
      `formatForSpecialist: fallback adapter '${FALLBACK_SPECIALIST_ID}' missing from registry. ` +
        `Built-in seeds should always register it; verify createSpecialistRegistry was called.`,
    );
  }
  bus?.emit(
    'specialist:fallback_used' as never,
    {
      requestedId,
      fallbackId: FALLBACK_SPECIALIST_ID,
      reason,
    } as never,
  );
  const fallbackDef = registry.get(FALLBACK_SPECIALIST_ID);
  const merged = mergeParameters(fallbackDef?.defaultParameters, req.parameters);
  const response = fallbackAdapter({ ...req, parameters: merged });
  return { ...response, resolvedSpecialistId: FALLBACK_SPECIALIST_ID, fellBack: true };
}

function mergeParameters(
  defaults: Record<string, string | number | boolean> | undefined,
  override: Record<string, string | number | boolean | undefined> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (defaults) {
    for (const [k, v] of Object.entries(defaults)) {
      if (v !== undefined) out[k] = v;
    }
  }
  if (override) {
    for (const [k, v] of Object.entries(override)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}
