/**
 * OS Keychain credential loader (G2+ — A6 credential isolation).
 *
 * Loads provider API keys from the OS keychain at orchestrator startup,
 * populating `process.env` only if the env var is not already set. This
 * pairs with the LLM proxy (A6 credential isolation) so that credentials
 * never sit in shell-history-visible env vars or in vinyan.json.
 *
 * Backends:
 *   - macOS  : `security find-generic-password -s <service> -a <account> -w`
 *   - Linux  : `secret-tool lookup service <service> account <account>`
 *   - Windows: deferred (use env var or `.env` file for now)
 *
 * Tools that aren't installed (Linux without libsecret) return null gracefully —
 * the caller falls back to env var lookup. Lookup is synchronous because it
 * runs once at startup and the underlying CLI tools complete in <100ms.
 *
 * Convention: stored under service `vinyan`, account = full env-var name
 * (e.g., `ANTHROPIC_API_KEY`). Set up macOS:
 *   security add-generic-password -s vinyan -a ANTHROPIC_API_KEY -w sk-ant-...
 *
 * Linux (libsecret):
 *   echo -n "sk-ant-..." | secret-tool store --label "Vinyan Anthropic key" \
 *     service vinyan account ANTHROPIC_API_KEY
 *
 * Axioms: A6 (Zero-Trust Execution — credentials don't sit in env shared
 * with worker subprocesses; combined with the LLM proxy the workers never
 * see them at all).
 */

import { platform } from 'node:os';
import { spawnSync } from 'bun';

export type KeychainBackend = 'darwin' | 'linux' | 'unsupported';

export function detectBackend(): KeychainBackend {
  const p = platform();
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  return 'unsupported';
}

/**
 * Look up a single credential. Returns `null` when:
 *   - The platform has no supported backend (Windows for now).
 *   - The required CLI tool isn't installed (e.g., `secret-tool` missing).
 *   - The keychain has no entry for the (service, account) pair.
 *   - The user denied keychain access (macOS prompts on first read).
 *
 * Never throws — failure modes resolve to null so the caller can fall back
 * to env vars or `.env` files without try/catch noise.
 */
export function loadCredential(service: string, account: string): string | null {
  const backend = detectBackend();
  try {
    if (backend === 'darwin') {
      const proc = spawnSync(['security', 'find-generic-password', '-s', service, '-a', account, '-w'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (proc.exitCode === 0) {
        const value = new TextDecoder().decode(proc.stdout).trim();
        return value.length > 0 ? value : null;
      }
      return null;
    }
    if (backend === 'linux') {
      const proc = spawnSync(['secret-tool', 'lookup', 'service', service, 'account', account], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (proc.exitCode === 0) {
        const value = new TextDecoder().decode(proc.stdout).trim();
        return value.length > 0 ? value : null;
      }
      return null;
    }
    return null;
  } catch {
    // CLI not installed or spawn failed — caller falls back to env.
    return null;
  }
}

/** Provider env-var names checked at startup. */
export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
] as const;

export interface KeychainPopulationResult {
  /** Env var names populated from the keychain on this call. */
  populated: string[];
  /** Env var names left untouched (already set, or no keychain entry). */
  skipped: string[];
  /** Backend used for lookup. */
  backend: KeychainBackend;
}

/**
 * Populate provider API keys in `process.env` from the OS keychain.
 *
 * Precedence: existing `process.env[KEY]` wins. The keychain only fills gaps.
 * This is intentional so a developer who sets `ANTHROPIC_API_KEY=sk-test-...`
 * for a specific run can override the stored key without touching keychain.
 *
 * Idempotent: calling twice yields the same result; a second call sees the
 * env vars populated by the first and reports them as `skipped`.
 */
export function populateProviderKeysFromKeychain(
  service: string = 'vinyan',
  envKeys: readonly string[] = PROVIDER_ENV_KEYS,
): KeychainPopulationResult {
  const backend = detectBackend();
  const populated: string[] = [];
  const skipped: string[] = [];
  for (const key of envKeys) {
    if (process.env[key]) {
      skipped.push(key);
      continue;
    }
    const value = loadCredential(service, key);
    if (value) {
      process.env[key] = value;
      populated.push(key);
    } else {
      skipped.push(key);
    }
  }
  return { populated, skipped, backend };
}
