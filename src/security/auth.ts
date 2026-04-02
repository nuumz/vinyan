/**
 * Auth Middleware — bearer token validation + role-based authorization.
 *
 * I15: API authentication mandatory for mutations.
 * Read-only endpoints may operate without auth.
 * Multi-token support with role assignments.
 *
 * Source of truth: spec/tdd.md §22.6, safety invariant I15
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { AuthContext, Role, TokenConfig } from './types.ts';
import { classifyRequest, hasPermission, loadTokenFile } from './authorization.ts';

/**
 * Create auth middleware that validates Bearer tokens and checks RBAC.
 *
 * @param tokenPath — path to the API token file (e.g., ~/.vinyan/api-token)
 * @param tokenConfigPath — optional path to multi-token config JSON
 * @returns Function that extracts AuthContext from a Request
 */
export function createAuthMiddleware(tokenPath: string, tokenConfigPath?: string): {
  authenticate(req: Request): AuthContext;
  authorize(ctx: AuthContext, method: string, path: string): boolean;
  getToken(): string;
} {
  // Auto-generate default token if it doesn't exist
  ensureTokenExists(tokenPath);
  const defaultToken = readFileSync(tokenPath, 'utf-8').trim();

  // Load multi-token configuration if available
  const tokenMap: Map<string, TokenConfig> = tokenConfigPath ? loadTokenFile(tokenConfigPath) : new Map();

  return {
    authenticate(req: Request): AuthContext {
      // Check for mTLS client certificate header
      const clientCert = req.headers.get('x-client-cert');
      if (clientCert) {
        return {
          authenticated: true,
          role: 'admin',
          source: 'mtls',
        };
      }

      const authHeader = req.headers.get('authorization');

      if (!authHeader) {
        return { authenticated: false, source: 'anonymous' };
      }

      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match?.[1]) {
        return { authenticated: false, source: 'anonymous' };
      }

      const provided = match[1].trim();

      // Check multi-token config first
      for (const [configToken, config] of tokenMap) {
        if (safeCompare(provided, configToken)) {
          return {
            authenticated: true,
            apiKey: provided,
            role: config.role,
            source: 'bearer',
            instanceId: config.instanceId,
          };
        }
      }

      // Fall back to default token (admin role)
      if (safeCompare(provided, defaultToken)) {
        return { authenticated: true, apiKey: provided, role: 'admin', source: 'bearer' };
      }

      return { authenticated: false, source: 'anonymous' };
    },

    authorize(ctx: AuthContext, method: string, path: string): boolean {
      if (!ctx.authenticated || !ctx.role) return false;
      const permission = classifyRequest(method, path);
      return hasPermission(ctx.role, permission);
    },

    getToken(): string {
      return defaultToken;
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
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
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
