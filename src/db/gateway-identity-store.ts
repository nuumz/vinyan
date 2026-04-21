/**
 * GatewayIdentityStore — read/write surface for `gateway_identity` and
 * `gateway_pairing_tokens` (migration 006).
 *
 * The dispatcher uses this store to:
 *   1. Upsert every sender we see (touching `last_seen_at`).
 *   2. Resolve pairing tokens presented via `/pair <token>`.
 *   3. Promote an identity from `unknown`/`pairing` to `paired` on
 *      successful token consumption.
 *
 * Profile scoping (w1-contracts §3): every row carries `profile`; writers
 * must supply it, and `getIdentity` returns rows regardless of profile
 * (identity is keyed on `(platform, platformUserId)` globally) but the
 * `profile` field is preserved on the returned row so callers can gate.
 */
import type { Database } from 'bun:sqlite';

export type TrustTier = 'unknown' | 'pairing' | 'paired' | 'admin';

export interface GatewayIdentityRow {
  gatewayUserId: string;
  profile: string;
  platform: string;
  platformUserId: string;
  displayName: string | null;
  trustTier: TrustTier;
  pairedAt: number | null;
  lastSeenAt: number | null;
}

export interface PairingTokenRow {
  token: string;
  profile: string;
  platform: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedBy: string | null;
}

interface IdentityDBRow {
  gateway_user_id: string;
  profile: string;
  platform: string;
  platform_user_id: string;
  display_name: string | null;
  trust_tier: TrustTier;
  paired_at: number | null;
  last_seen_at: number | null;
}

interface PairingTokenDBRow {
  token: string;
  profile: string;
  platform: string;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_by: string | null;
}

export class GatewayIdentityStore {
  constructor(private readonly db: Database) {}

  // ── Identity ──────────────────────────────────────────────────────

  /**
   * Create-or-update a sender's identity row. If the row already exists the
   * trust tier is preserved (upgrades go through `promoteToPaired`) and
   * only the mutable fields (display_name, last_seen_at, profile) are
   * refreshed.
   */
  upsertIdentity(args: {
    profile: string;
    platform: string;
    platformUserId: string;
    displayName?: string | null;
    trustTier: TrustTier;
    lastSeenMs: number;
  }): { gatewayUserId: string; isNew: boolean } {
    const existing = this.getIdentity(args.platform, args.platformUserId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE gateway_identity
              SET display_name = COALESCE(?, display_name),
                  last_seen_at = ?,
                  profile      = ?
            WHERE gateway_user_id = ?`,
        )
        .run(args.displayName ?? null, args.lastSeenMs, args.profile, existing.gatewayUserId);
      return { gatewayUserId: existing.gatewayUserId, isNew: false };
    }

    const gatewayUserId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO gateway_identity
           (gateway_user_id, profile, platform, platform_user_id,
            display_name, trust_tier, paired_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        gatewayUserId,
        args.profile,
        args.platform,
        args.platformUserId,
        args.displayName ?? null,
        args.trustTier,
        null,
        args.lastSeenMs,
      );
    return { gatewayUserId, isNew: true };
  }

  getIdentity(platform: string, platformUserId: string): GatewayIdentityRow | null {
    const row = this.db
      .prepare(
        `SELECT gateway_user_id, profile, platform, platform_user_id,
                display_name, trust_tier, paired_at, last_seen_at
           FROM gateway_identity
          WHERE platform = ? AND platform_user_id = ?`,
      )
      .get(platform, platformUserId) as IdentityDBRow | null;
    return row ? rowToIdentity(row) : null;
  }

  /** Promote an identity to `paired` and stamp `paired_at`. */
  promoteToPaired(gatewayUserId: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE gateway_identity
            SET trust_tier = 'paired',
                paired_at  = COALESCE(paired_at, ?)
          WHERE gateway_user_id = ?`,
      )
      .run(nowMs, gatewayUserId);
  }

  // ── Pairing tokens ────────────────────────────────────────────────

  /** Issue a new pairing token. Caller supplies the TTL. */
  issuePairingToken(args: { profile: string; platform: string; ttlMs: number; nowMs?: number }): {
    token: string;
    expiresAt: number;
  } {
    const now = args.nowMs ?? Date.now();
    const expiresAt = now + args.ttlMs;
    const token = generateToken();
    this.db
      .prepare(
        `INSERT INTO gateway_pairing_tokens
           (token, profile, platform, issued_at, expires_at, consumed_at, consumed_by)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(token, args.profile, args.platform, now, expiresAt);
    return { token, expiresAt };
  }

  /**
   * Atomically validate + consume a pairing token. On success the token
   * row is flipped to `consumed`; a second call returns `already-consumed`.
   */
  consumePairingToken(args: { token: string; consumedBy: string; nowMs: number }):
    | { ok: true; row: PairingTokenRow }
    | { ok: false; reason: 'not-found' | 'expired' | 'already-consumed' } {
    const row = this.db
      .prepare(
        `SELECT token, profile, platform, issued_at, expires_at, consumed_at, consumed_by
           FROM gateway_pairing_tokens
          WHERE token = ?`,
      )
      .get(args.token) as PairingTokenDBRow | null;

    if (!row) return { ok: false, reason: 'not-found' };
    if (row.consumed_at !== null) return { ok: false, reason: 'already-consumed' };
    if (row.expires_at <= args.nowMs) return { ok: false, reason: 'expired' };

    this.db
      .prepare(
        `UPDATE gateway_pairing_tokens
            SET consumed_at = ?, consumed_by = ?
          WHERE token = ? AND consumed_at IS NULL`,
      )
      .run(args.nowMs, args.consumedBy, args.token);

    return {
      ok: true,
      row: {
        token: row.token,
        profile: row.profile,
        platform: row.platform,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        consumedAt: args.nowMs,
        consumedBy: args.consumedBy,
      },
    };
  }
}

function rowToIdentity(r: IdentityDBRow): GatewayIdentityRow {
  return {
    gatewayUserId: r.gateway_user_id,
    profile: r.profile,
    platform: r.platform,
    platformUserId: r.platform_user_id,
    displayName: r.display_name,
    trustTier: r.trust_tier,
    pairedAt: r.paired_at,
    lastSeenAt: r.last_seen_at,
  };
}

/**
 * Generate a short, URL-safe, human-pasteable pairing token. The token is
 * derived from crypto.getRandomValues — collision probability is negligible
 * for the intended (human, short TTL) lifetime.
 */
function generateToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
