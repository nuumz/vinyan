/**
 * Role-Based Access Control — maps tokens to roles and roles to permissions.
 *
 * 3-tier model: readonly → operator → admin (cumulative).
 * Source of truth: spec/tdd.md §22.6 (API auth + RBAC)
 */

import { existsSync, readFileSync } from 'fs';
import type { Role, TokenConfig, TokenFile } from './types.ts';
import { TokenFileSchema } from './types.ts';

// ── Permission Matrix ─────────────────────────────────────────────────

const READONLY_PERMISSIONS = new Set([
  'read:health',
  'read:metrics',
  'read:facts',
  'read:workers',
  'read:events',
  'read:tasks',
  'read:sessions',
  'read:rules',
]);

const OPERATOR_PERMISSIONS = new Set([...READONLY_PERMISSIONS, 'write:tasks', 'write:sessions']);

const ADMIN_PERMISSIONS = new Set([...OPERATOR_PERMISSIONS, 'admin:config', 'admin:instances', 'admin:workers']);

export const ROLE_PERMISSIONS: Record<Role, Set<string>> = {
  readonly: READONLY_PERMISSIONS,
  operator: OPERATOR_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
};

// ── Permission Check ──────────────────────────────────────────────────

/** Check if a role has a specific permission. */
export function hasPermission(role: Role, permission: string): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

// ── Request Classification ────────────────────────────────────────────

/** Map an HTTP request to the permission it requires. */
export function classifyRequest(method: string, path: string): string {
  const upper = method.toUpperCase();

  // Health / metrics — always read
  if (path === '/api/v1/health') return 'read:health';
  if (path === '/api/v1/metrics') return 'read:metrics';

  // Workers
  if (path.startsWith('/api/v1/workers')) {
    return upper === 'GET' ? 'read:workers' : 'admin:workers';
  }

  // Facts / rules
  if (path.startsWith('/api/v1/facts')) return 'read:facts';
  if (path.startsWith('/api/v1/rules')) return 'read:rules';

  // Agents / skills / patterns (read-only)
  if (path.startsWith('/api/v1/agents')) return 'read:agents';
  if (path.startsWith('/api/v1/skills')) return 'read:skills';
  if (path.startsWith('/api/v1/patterns')) return 'read:patterns';

  // Doctor / MCP (read-only diagnostics)
  if (path.startsWith('/api/v1/doctor')) return 'read:doctor';
  if (path.startsWith('/api/v1/mcp')) return 'read:mcp';

  // Oracles (read-only) + Sleep Cycle (read + trigger)
  if (path.startsWith('/api/v1/oracles')) return 'read:oracles';
  if (path.startsWith('/api/v1/sleep-cycle')) {
    return upper === 'GET' ? 'read:sleep-cycle' : 'admin:sleep-cycle';
  }

  // Week 5-6: shadow / traces / memory / calibration / hms
  if (path.startsWith('/api/v1/shadow')) return 'read:shadow';
  if (path.startsWith('/api/v1/traces')) return 'read:traces';
  if (path.startsWith('/api/v1/memory')) {
    return upper === 'GET' ? 'read:memory' : 'admin:memory';
  }
  if (path.startsWith('/api/v1/predictions')) return 'read:predictions';
  if (path.startsWith('/api/v1/hms')) return 'read:hms';

  // Tier 3: peers / providers / federation / market
  if (path.startsWith('/api/v1/peers')) return 'read:peers';
  if (path.startsWith('/api/v1/providers')) return 'read:providers';
  if (path.startsWith('/api/v1/federation')) return 'read:federation';
  if (path.startsWith('/api/v1/market')) return 'read:market';

  // Events (SSE stream)
  if (path.startsWith('/api/v1/events')) return 'read:events';

  // Tasks
  if (path.startsWith('/api/v1/tasks')) {
    return upper === 'GET' ? 'read:tasks' : 'write:tasks';
  }

  // Sessions
  if (path.startsWith('/api/v1/sessions')) {
    return upper === 'GET' ? 'read:sessions' : 'write:sessions';
  }

  // Config / admin
  if (path.startsWith('/api/v1/config')) return 'admin:config';
  if (path.startsWith('/api/v1/instances')) return 'admin:instances';

  // Default: admin — deny by default for unknown endpoints
  return 'admin:config';
}

// ── Token File Loader ─────────────────────────────────────────────────

/**
 * Load token→role mappings from a JSON file.
 * File format: { "tokens": [{ "token": "...", "role": "...", "instanceId?": "..." }] }
 *
 * @returns Map of token → TokenConfig
 */
export function loadTokenFile(tokenFilePath: string): Map<string, TokenConfig> {
  const map = new Map<string, TokenConfig>();

  if (!existsSync(tokenFilePath)) return map;

  try {
    const raw = readFileSync(tokenFilePath, 'utf-8');
    const parsed: TokenFile = TokenFileSchema.parse(JSON.parse(raw));
    for (const entry of parsed.tokens) {
      map.set(entry.token, entry);
    }
  } catch {
    // Invalid file → return empty map (fail-closed)
  }

  return map;
}
