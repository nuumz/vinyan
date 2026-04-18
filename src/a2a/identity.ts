/**
 * Shared A2A identity util — resolves the per-workspace instance UUID.
 *
 * File: `.vinyan/instance-id` — created on first call, reused forever.
 * Used by both A2AManager and the factory (AgentProfile bootstrap) so they
 * agree on the same instance UUID for this workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read or create the workspace's A2A instance UUID.
 * Idempotent — safe to call from multiple bootstrap paths.
 */
export function resolveInstanceId(workspace: string): string {
  const vinyanDir = join(workspace, '.vinyan');
  const idPath = join(vinyanDir, 'instance-id');

  if (existsSync(idPath)) {
    return readFileSync(idPath, 'utf-8').trim();
  }

  if (!existsSync(vinyanDir)) {
    mkdirSync(vinyanDir, { recursive: true });
  }

  const id = crypto.randomUUID();
  writeFileSync(idPath, id);
  return id;
}
