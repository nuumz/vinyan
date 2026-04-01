/**
 * ECP Confidence Clamping — ECP spec §4.4, A5 (Tiered Trust).
 *
 * Confidence is clamped by two independent ceilings:
 * 1. Trust tier (intrinsic to the engine): deterministic=1.0, heuristic=0.9, probabilistic=0.7, speculative=0.4
 * 2. Transport layer (extrinsic): stdio=1.0, websocket=0.95, http=0.7
 *
 * Applied at verdict intake — before aggregation or storage.
 *
 * Source of truth: spec/ecp-spec.md §4.4, architecture/protocol-architecture.md §3/§6
 */

/** ECP spec §4.4: Confidence caps by trust tier. */
const TIER_CAPS: Record<string, number> = {
  deterministic: 1.0,
  heuristic: 0.9,
  probabilistic: 0.7,
  speculative: 0.4,
};

/** Protocol Architecture §3: Transport-level trust degradation. */
const TRANSPORT_CAPS: Record<string, number> = {
  stdio: 1.0,
  websocket: 0.95,
  http: 0.7,
};

/** Clamp confidence by tier ceiling (A5: Tiered Trust). */
export function clampByTier(confidence: number, tier?: string): number {
  if (!tier) return confidence;
  const cap = TIER_CAPS[tier] ?? 1.0;
  return Math.min(confidence, cap);
}

/** Apply transport-level trust degradation (Protocol Architecture §3). */
export function clampByTransport(confidence: number, transport?: string): number {
  if (!transport || transport === "stdio") return confidence;
  const cap = TRANSPORT_CAPS[transport] ?? 1.0;
  return Math.min(confidence, cap);
}

/** Full ECP confidence adjustment: tier clamp + transport degradation. */
export function clampConfidence(confidence: number, tier?: string, transport?: string): number {
  return clampByTransport(clampByTier(confidence, tier), transport);
}
