/**
 * vinyan doctor — workspace health check.
 *
 * Validates: config, database, oracles, LLM providers, economy, sessions.
 * Reports issues with actionable fix suggestions.
 *
 * The check loop is exposed as `runDoctorChecks()` so the HTTP API can
 * reuse the same logic. The CLI entry point (`runDoctor`) wraps it with
 * console rendering and an exit code.
 */

import { existsSync } from 'fs';
import { join } from 'path';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorOptions {
  /** Include expensive checks (tsc) — off by default when called from a live server. */
  deep?: boolean;
}

/**
 * Run all workspace health checks and return the structured result.
 * Never prints; never exits. Safe to call from HTTP handlers and tests.
 */
export async function runDoctorChecks(
  workspace: string,
  options: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. Workspace
  checks.push(
    existsSync(workspace)
      ? { name: 'Workspace', status: 'ok', detail: workspace }
      : { name: 'Workspace', status: 'fail', detail: `Directory not found: ${workspace}` },
  );

  // 2. Config
  const configPath = join(workspace, 'vinyan.json');
  if (existsSync(configPath)) {
    try {
      const { loadConfig } = await import('../config/index.ts');
      const config = loadConfig(workspace);
      checks.push({ name: 'Config', status: 'ok', detail: `vinyan.json loaded` });

      // 2a. Oracles
      const oracles = config.oracles ?? {};
      const enabledOracles = Object.entries(oracles).filter(([, v]) => (v as { enabled?: boolean })?.enabled);
      checks.push({
        name: 'Oracles',
        status: enabledOracles.length > 0 ? 'ok' : 'warn',
        detail: enabledOracles.length > 0
          ? `${enabledOracles.length} enabled: ${enabledOracles.map(([k]) => k).join(', ')}`
          : 'No oracles enabled — verification will be limited',
      });

      // 2b. Economy
      const econ = config.economy;
      checks.push({
        name: 'Economy',
        status: econ?.enabled ? 'ok' : 'warn',
        detail: econ?.enabled
          ? `Enabled${econ.budgets ? ` — budgets: hourly=$${econ.budgets.hourly_usd}, daily=$${econ.budgets.daily_usd}` : ' — no budget limits'}`
          : 'Disabled — set economy.enabled: true in vinyan.json',
      });

      // 2c. Network/API
      const api = config.network?.api;
      checks.push({
        name: 'API Server',
        status: api?.enabled !== false ? 'ok' : 'warn',
        detail: api?.enabled !== false ? `Port ${api?.port ?? 3927}` : 'Disabled',
      });
    } catch (err) {
      checks.push({ name: 'Config', status: 'fail', detail: `Invalid vinyan.json: ${err instanceof Error ? err.message : String(err)}` });
    }
  } else {
    checks.push({ name: 'Config', status: 'fail', detail: 'vinyan.json not found — run `vinyan init`' });
  }

  // 3. Database
  const dbPath = join(workspace, '.vinyan', 'vinyan.db');
  if (existsSync(dbPath)) {
    try {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      db.close();
      checks.push({ name: 'Database', status: 'ok', detail: `${tables.length} tables in vinyan.db` });
    } catch (err) {
      checks.push({ name: 'Database', status: 'fail', detail: `DB corrupt: ${err instanceof Error ? err.message : String(err)}` });
    }
  } else {
    checks.push({ name: 'Database', status: 'warn', detail: 'No database yet — will be created on first run' });
  }

  // 4. API Token
  const tokenPath = join(workspace, '.vinyan', 'api-token');
  checks.push(
    existsSync(tokenPath)
      ? { name: 'API Token', status: 'ok', detail: '.vinyan/api-token exists' }
      : { name: 'API Token', status: 'warn', detail: 'No API token — will be auto-generated on serve' },
  );

  // 5. LLM Provider (env vars)
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (hasOpenRouter || hasAnthropic) {
    const providers: string[] = [];
    if (hasOpenRouter) providers.push('OpenRouter');
    if (hasAnthropic) providers.push('Anthropic');
    checks.push({ name: 'LLM Provider', status: 'ok', detail: providers.join(' + ') });
  } else {
    checks.push({ name: 'LLM Provider', status: 'fail', detail: 'No OPENROUTER_API_KEY or ANTHROPIC_API_KEY — set in .env' });
  }

  // 6. TypeScript (tsc) — expensive, only when explicitly requested
  if (options.deep) {
    try {
      const proc = Bun.spawn(['tsc', '--noEmit', '--pretty', 'false'], {
        cwd: workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      checks.push(
        exitCode === 0
          ? { name: 'TypeScript', status: 'ok', detail: 'tsc --noEmit passes' }
          : { name: 'TypeScript', status: 'warn', detail: `tsc --noEmit has errors (exit ${exitCode})` },
      );
    } catch {
      checks.push({ name: 'TypeScript', status: 'warn', detail: 'tsc not available — skip type check' });
    }
  }

  // 7. Sessions
  if (existsSync(dbPath)) {
    try {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const sessions = db.query("SELECT COUNT(*) as c FROM sessions WHERE status = 'active'").get() as { c: number } | null;
      const suspended = db.query("SELECT COUNT(*) as c FROM sessions WHERE status = 'suspended'").get() as { c: number } | null;
      db.close();
      checks.push({
        name: 'Sessions',
        status: 'ok',
        detail: `${sessions?.c ?? 0} active, ${suspended?.c ?? 0} suspended`,
      });
    } catch {
      checks.push({ name: 'Sessions', status: 'warn', detail: 'Sessions table not yet created' });
    }
  }

  return checks;
}

/** Overall verdict from a set of check results. */
export function summarizeChecks(checks: DoctorCheck[]): {
  status: 'healthy' | 'degraded' | 'critical';
  passed: number;
  total: number;
} {
  const total = checks.length;
  const passed = checks.filter((c) => c.status === 'ok').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;

  const status: 'healthy' | 'degraded' | 'critical' =
    failed > 0 ? 'critical' : warned > 0 ? 'degraded' : 'healthy';

  return { status, passed, total };
}

/** CLI entry point — runs the checks with deep mode and prints to console. */
export async function runDoctor(workspace: string): Promise<void> {
  const checks = await runDoctorChecks(workspace, { deep: true });

  console.log('\n  Vinyan Doctor — Health Check\n');

  let hasFailures = false;
  for (const check of checks) {
    const icon = check.status === 'ok' ? '\x1b[32m✓\x1b[0m' : check.status === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const color = check.status === 'ok' ? '' : check.status === 'warn' ? '\x1b[33m' : '\x1b[31m';
    const reset = check.status === 'ok' ? '' : '\x1b[0m';
    console.log(`  ${icon} ${check.name.padEnd(14)} ${color}${check.detail}${reset}`);
    if (check.status === 'fail') hasFailures = true;
  }

  const { passed, total } = summarizeChecks(checks);
  console.log(`\n  ${passed}/${total} checks passed\n`);

  if (hasFailures) process.exit(1);
}
