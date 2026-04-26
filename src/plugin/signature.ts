/**
 * Plugin integrity + signature verification (W2).
 *
 * Integrity:
 *   SHA-256 over the entry file bytes, compared to the manifest's `sha256`
 *   field. Uses Web Crypto (`crypto.subtle.digest`) via Bun's built-in
 *   `Bun.file(path).arrayBuffer()` reader — zero extra dependencies.
 *
 * Signature:
 *   MVP stub. The manifest may declare `signature.algorithm: 'minisign'`,
 *   `signature.publicKey`, and `signature.value`. Actual ed25519 / minisign
 *   verification is deferred to a follow-up PR; this stub accepts the
 *   signature iff the declared `publicKey` byte-for-byte matches a publisher
 *   in the caller-supplied `TrustConfig.publishers`. This is explicitly NOT
 *   cryptographically meaningful — it exists only to exercise the tier
 *   derivation + FSM wiring end-to-end so consumers (factory.ts, CLI) can
 *   integrate against a stable surface today.
 *
 * Tier derivation (deterministic, A5):
 *   - integrity fail                                    → throw (not a tier)
 *   - integrity ok + signed + trusted publisher         → `deterministic`
 *   - integrity ok + unsigned + permissive mode         → `speculative`
 *   - integrity ok + signed but invalid/untrusted       → load refused
 */
import path from 'node:path';
import type { ConfidenceTier } from '../core/confidence-tier.ts';
import type { PluginManifest } from './manifest.ts';

// ── Config shapes ────────────────────────────────────────────────────────

export interface TrustedPublisher {
  id: string;
  /** Base64-encoded public key. Compared byte-for-byte in MVP stub. */
  publicKey: string;
  algorithm: 'minisign';
}

export interface TrustConfig {
  publishers: TrustedPublisher[];
  /**
   * When true, unsigned plugins that pass integrity are loaded with tier
   * demoted to `speculative`. When false, unsigned plugins are refused.
   */
  permissive: boolean;
}

// ── Integrity ────────────────────────────────────────────────────────────

export type IntegrityResult =
  | { ok: true; computedSha256: string }
  | { ok: false; reason: 'missing' | 'mismatch'; detail: string };

export async function verifyIntegrity(rootDir: string, manifest: PluginManifest): Promise<IntegrityResult> {
  const entryPath = path.resolve(rootDir, manifest.entry);
  const file = Bun.file(entryPath);
  const exists = await file.exists();
  if (!exists) {
    return {
      ok: false,
      reason: 'missing',
      detail: `entry file not found: ${entryPath}`,
    };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    return {
      ok: false,
      reason: 'missing',
      detail: `failed to read entry file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const computed = await sha256Hex(bytes);
  if (computed !== manifest.sha256) {
    return {
      ok: false,
      reason: 'mismatch',
      detail: `expected ${manifest.sha256}, computed ${computed}`,
    };
  }
  return { ok: true, computedSha256: computed };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += (view[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}

// ── Signature (MVP stub — see module docblock) ───────────────────────────

export type SignatureResult =
  | { ok: true; publisher: TrustedPublisher }
  | { ok: false; reason: 'unsigned' | 'untrusted-publisher' | 'invalid' };

export async function verifySignature(manifest: PluginManifest, trust: TrustConfig): Promise<SignatureResult> {
  if (!manifest.signature) {
    return { ok: false, reason: 'unsigned' };
  }
  // MVP stub: byte-compare declared publicKey against the trusted-publisher set.
  // Real ed25519/minisign verification is a follow-up PR.
  const declared = manifest.signature.publicKey;
  const match = trust.publishers.find((p) => p.algorithm === 'minisign' && p.publicKey === declared);
  if (!match) {
    return { ok: false, reason: 'untrusted-publisher' };
  }
  // In MVP we have no cryptographic `invalid` path — signature.value is not
  // checked. Kept in the return union so callers can wire it now without
  // re-typing later.
  return { ok: true, publisher: match };
}

// ── Effective tier ───────────────────────────────────────────────────────

/**
 * Compute the effective trust tier from integrity + signature + mode.
 * Throws if integrity failed — callers should check integrity first and
 * surface a rejection rather than asking for a tier.
 *
 * Rule (A5, deterministic):
 *   integrity ok + signature.ok           → 'deterministic'
 *   integrity ok + unsigned + permissive  → 'speculative'
 *   integrity ok + unsigned + strict      → throw (caller should refuse)
 *   integrity ok + signed-but-rejected    → throw (caller should refuse)
 */
export function effectiveTrustTier(
  integrity: IntegrityResult,
  signature: SignatureResult,
  permissive: boolean,
): ConfidenceTier {
  if (!integrity.ok) {
    throw new Error(`effectiveTrustTier called on integrity-failed plugin: ${integrity.detail}`);
  }
  if (signature.ok) return 'deterministic';
  if (signature.reason === 'unsigned' && permissive) return 'speculative';
  // Signed-but-untrusted OR unsigned-under-strict → not a loadable state.
  throw new Error(`plugin not trustable: signature=${signature.reason}, permissive=${permissive}`);
}
