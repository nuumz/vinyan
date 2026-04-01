/**
 * Auth Middleware — bearer token validation for API endpoints.
 *
 * I15: API authentication mandatory for mutations.
 * Read-only endpoints may operate without auth.
 *
 * Source of truth: spec/tdd.md §22.6, safety invariant I15
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { AuthContext } from './types.ts';

/**
 * Create auth middleware that validates Bearer tokens.
 *
 * @param tokenPath — path to the API token file (e.g., ~/.vinyan/api-token)
 * @returns Function that extracts AuthContext from a Request
 */
export function createAuthMiddleware(tokenPath: string): {
  authenticate(req: Request): AuthContext;
  getToken(): string;
} {
  // Auto-generate token if it doesn't exist
  ensureTokenExists(tokenPath);
  const token = readFileSync(tokenPath, 'utf-8').trim();

  return {
    authenticate(req: Request): AuthContext {
      const authHeader = req.headers.get('authorization');

      if (!authHeader) {
        return { authenticated: false, source: 'anonymous' };
      }

      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match?.[1]) {
        return { authenticated: false, source: 'anonymous' };
      }

      const provided = match[1].trim();
      if (safeCompare(provided, token)) {
        return { authenticated: true, apiKey: provided, source: 'bearer' };
      }

      return { authenticated: false, source: 'anonymous' };
    },

    getToken(): string {
      return token;
    },
  };
}

/** Constant-time string comparison to prevent timing side-channel attacks. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Ensure the token file exists, generating one if needed.
 */
function ensureTokenExists(tokenPath: string): void {
  if (existsSync(tokenPath)) return;

  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
}

/**
 * Check whether a request requires authentication based on the endpoint.
 * Mutation endpoints (POST, PUT, DELETE on task/session routes) require auth.
 * Read-only endpoints (GET health, metrics, facts) do not.
 */
export function requiresAuth(method: string, path: string): boolean {
  // Health and metrics are always public
  if (path === '/api/v1/health' || path === '/api/v1/metrics') return false;

  // Read-only query endpoints
  if (method === 'GET' && (path === '/api/v1/facts' || path === '/api/v1/workers' || path === '/api/v1/rules'))
    return false;

  // SSE event streams require auth
  // All POST/PUT/DELETE require auth
  // All other endpoints require auth
  return true;
}
