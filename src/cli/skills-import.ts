/**
 * `vinyan skills import <id>` — user-facing CLI for W3 SK3 hub import.
 *
 * Drives the `SkillImporter` state machine from the command line, using
 * CLI stubs for the gate + critic (TODO W4 wires the real ones). Exits
 * non-zero on rejection / error; zero on `promoted`.
 *
 * Flags:
 *   --dry-run               Halt after `dry_run_done` (before critic + promote).
 *   --profile <p>           Profile namespace (mirrors other CLI commands).
 *   --permissive-guardrails Disable injection + bypass scans (sealed test workspaces).
 *
 * Usage example:
 *   vinyan skills import github:alice/some-repo@main/skills/foo
 *   vinyan skills import agentskills:refactor/extract-method --dry-run
 */
import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { resolveProfile } from '../config/profile-resolver.ts';
import { type SkillTrustLedgerRecord, SkillTrustLedgerStore } from '../db/skill-trust-ledger-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { SkillArtifactStore } from '../skills/artifact-store.ts';
import {
  AgentskillsIoAdapter,
  GitHubAdapter,
  type ImportState,
  SkillImporter,
  type SkillImporterHandle,
} from '../skills/hub/index.ts';
import type { SkillRegistryAdapter } from '../skills/hub/registry-adapter.ts';
import { StoreBackedSkillTrustLedger } from '../skills/hub/trust-ledger.ts';
import { stubImporterCriticFn, stubImporterGateFn } from './oracle-stubs.ts';

export interface SkillsImportFlags {
  readonly id: string;
  readonly dryRun: boolean;
  readonly permissiveGuardrails: boolean;
  readonly profile?: string;
}

export interface SkillsImportDeps {
  /** Pre-opened SQLite. Tests pass a `:memory:` DB. */
  readonly db?: Database;
  /** Override profile name (skips filesystem resolution when `db` is set). */
  readonly profile?: string;
  /** Inject an adapter directly (tests use a fake). When set, skips prefix routing. */
  readonly adapter?: SkillRegistryAdapter;
  /** Inject an artifact store (tests use a temp dir). */
  readonly artifactStore?: SkillArtifactStore;
  /** Skip auto-building the importer handle — drop in a fake. */
  readonly importerHandle?: SkillImporterHandle;
  /** stdout / stderr capture for tests. */
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
  readonly exit?: (code: number) => never;
  /** Override clock for deterministic ledger timestamps. */
  readonly clock?: () => number;
}

interface Ctx {
  readonly db: Database;
  readonly profile: string;
  readonly artifactStore: SkillArtifactStore;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly clock: () => number;
  readonly ownsDb: boolean;
}

function parseFlags(args: readonly string[]): SkillsImportFlags | { error: string } {
  let id: string | undefined;
  let dryRun = false;
  let permissive = false;
  let profile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--permissive-guardrails') {
      permissive = true;
      continue;
    }
    if (a === '--profile' || a === '-p') {
      const v = args[++i];
      if (!v) return { error: `Missing value for ${a}` };
      profile = v;
      continue;
    }
    if (a?.startsWith('--profile=')) {
      profile = a.slice('--profile='.length);
      continue;
    }
    if (a?.startsWith('--')) {
      return { error: `Unknown flag: ${a}` };
    }
    if (id === undefined) {
      if (!a) return { error: 'Empty skill id' };
      id = a;
    }
  }
  if (!id) return { error: 'Missing skill id' };
  return profile !== undefined
    ? { id, dryRun, permissiveGuardrails: permissive, profile }
    : { id, dryRun, permissiveGuardrails: permissive };
}

function pickAdapter(id: string): SkillRegistryAdapter | { error: string } {
  if (id.startsWith('github:')) {
    return new GitHubAdapter();
  }
  if (id.startsWith('agentskills:')) {
    return new AgentskillsIoAdapter();
  }
  return { error: `Unknown skill id prefix in "${id}". Expected github: or agentskills:` };
}

export async function runSkillsImportCommand(args: readonly string[], deps: SkillsImportDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((c: string) => process.stdout.write(c));
  const stderr = deps.stderr ?? ((c: string) => process.stderr.write(c));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const parsed = parseFlags(args);
  if ('error' in parsed) {
    stderr(`${parsed.error}\n`);
    stderr('Usage: vinyan skills import <id> [--dry-run] [--profile <p>] [--permissive-guardrails]\n');
    exit(2);
    return;
  }
  const flags = parsed;

  // Resolve db + profile + artifact store.
  const ctx = await buildCtx(flags, deps);

  try {
    // Resolve adapter (unless caller injected one).
    const adapter = deps.adapter ?? pickAdapterOrExit(flags.id, ctx);

    // Build the importer handle. We DON'T use `setupSkillImporter` because
    // it assumes a real runGate (which expects to run oracles against a
    // live workspace); the CLI is operating before the factory plumbing
    // lands (TODO W4 in oracle-stubs.ts). Instead, build the handle
    // inline: real ledger (so trail is persistent + profile-scoped), stub
    // gate + critic (obvious, loudly announced).
    const handle =
      deps.importerHandle ??
      buildCliImporterHandle({
        db: ctx.db,
        profile: ctx.profile,
        adapter,
        artifactStore: ctx.artifactStore,
        clock: ctx.clock,
        permissive: flags.permissiveGuardrails,
      });

    stderr(
      `[vinyan-skills-hub] CLI is using gate + critic STUBS. For real verification, run via the\n` +
        `  factory-wired path (W4+). See src/cli/oracle-stubs.ts for TODOs.\n`,
    );

    const state = await handle.importer.import(flags.id);
    const trail = handle.ledger.history(flags.id);

    if (flags.dryRun) {
      printDryRunReport(ctx, flags.id, state, trail);
      // Dry-run always exits 0 unless the importer rejected the skill
      // before reaching the gate (fetch / scan / quarantine failures).
      exit(dryRunExitCode(state));
      return;
    }

    printReport(ctx, flags.id, state, trail);
    exit(state.kind === 'promoted' ? 0 : 1);
  } finally {
    if (ctx.ownsDb) {
      try {
        ctx.db.close();
      } catch {
        // best-effort
      }
    }
  }
}

async function buildCtx(flags: SkillsImportFlags, deps: SkillsImportDeps): Promise<Ctx> {
  const stdout = deps.stdout ?? ((c: string) => process.stdout.write(c));
  const stderr = deps.stderr ?? ((c: string) => process.stderr.write(c));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const clock = deps.clock ?? (() => Date.now());

  const ownsDb = deps.db === undefined;
  if (deps.db) {
    return {
      db: deps.db,
      profile: deps.profile ?? flags.profile ?? 'default',
      artifactStore:
        deps.artifactStore ?? new SkillArtifactStore({ rootDir: join(process.cwd(), '.vinyan', 'skills') }),
      stdout,
      stderr,
      exit,
      clock,
      ownsDb: false,
    };
  }
  const resolved = resolveProfile(flags.profile ? { flag: flags.profile } : {});
  const vdb = new VinyanDB(resolved.paths.dbFile);
  return {
    db: vdb.getDb(),
    profile: resolved.name,
    artifactStore: deps.artifactStore ?? new SkillArtifactStore({ rootDir: join(resolved.root, 'skills') }),
    stdout,
    stderr,
    exit,
    clock,
    ownsDb,
  };
}

function pickAdapterOrExit(id: string, ctx: Ctx): SkillRegistryAdapter {
  const picked = pickAdapter(id);
  if ('error' in picked) {
    ctx.stderr(`${picked.error}\n`);
    ctx.exit(1);
    // `process.exit` signature promises `never`; satisfy the compiler.
    throw new Error('unreachable');
  }
  return picked;
}

/**
 * Build a minimal `SkillImporterHandle` with CLI stub gate + critic and
 * a real SQLite-backed trust ledger. TODO(w4): replace with the real
 * `setupSkillImporter` once the factory-wired gate and critic are
 * reachable from the CLI.
 */
function buildCliImporterHandle(opts: {
  db: Database;
  profile: string;
  adapter: SkillRegistryAdapter;
  artifactStore: SkillArtifactStore;
  clock: () => number;
  permissive: boolean;
}): SkillImporterHandle {
  const ledgerStore = new SkillTrustLedgerStore(opts.db);
  const ledger = new StoreBackedSkillTrustLedger({
    store: ledgerStore,
    profile: opts.profile,
    clock: opts.clock,
  });

  const importer = new SkillImporter({
    adapter: opts.adapter,
    gate: stubImporterGateFn(),
    critic: stubImporterCriticFn(),
    trustLedger: ledger,
    artifactStore: opts.artifactStore,
    profile: opts.profile,
    workspace: process.cwd(),
    clock: opts.clock,
    ...(opts.permissive
      ? {
          guardrails: {
            detectInjection: () => ({ detected: false, patterns: [] }),
            detectBypass: () => ({ detected: false, patterns: [] }),
          },
        }
      : {}),
  });
  return { importer, ledger, ledgerStore };
}

function printReport(ctx: Ctx, id: string, state: ImportState, trail: readonly SkillTrustLedgerRecord[]): void {
  ctx.stdout(`Import: ${id}\n`);
  ctx.stdout(`Result: ${describeState(state)}\n`);
  ctx.stdout(`Ledger trail:\n`);
  for (const row of trail) {
    ctx.stdout(`  ${formatLedgerRow(row)}\n`);
  }
}

function printDryRunReport(ctx: Ctx, id: string, state: ImportState, trail: readonly SkillTrustLedgerRecord[]): void {
  ctx.stdout(`Import (dry-run): ${id}\n`);
  ctx.stdout(`State: ${state.kind}\n`);
  if (state.kind === 'dry_run_done') {
    ctx.stdout(
      `  gate: decision=${state.gateVerdict.decision}` +
        (state.gateVerdict.epistemicDecision ? ` epistemic=${state.gateVerdict.epistemicDecision}` : '') +
        (typeof state.gateVerdict.aggregateConfidence === 'number'
          ? ` confidence=${state.gateVerdict.aggregateConfidence.toFixed(2)}`
          : '') +
        `\n`,
    );
  } else if (state.kind === 'rejected') {
    ctx.stdout(`  rejected: ${state.reason}${state.ruleId ? ` (rule: ${state.ruleId})` : ''}\n`);
  }
  ctx.stdout(`Ledger trail:\n`);
  for (const row of trail) {
    ctx.stdout(`  ${formatLedgerRow(row)}\n`);
  }
}

function describeState(state: ImportState): string {
  switch (state.kind) {
    case 'promoted':
      return `promoted   (tier: ${state.toTier}, rule: ${state.ruleId})`;
    case 'rejected':
      return `rejected   (${state.reason}${state.ruleId ? `, rule: ${state.ruleId}` : ''})`;
    case 'critic_done':
      return `quarantine-continue (critic reviewed, not promoted)`;
    case 'dry_run_done':
      return `dry-run complete`;
    case 'quarantined':
      return `quarantined`;
    case 'scanned':
      return `scanned`;
    case 'fetched':
      return `fetched`;
  }
}

function formatLedgerRow(row: SkillTrustLedgerRecord): string {
  const ts = new Date(row.createdAt).toISOString();
  const parts: string[] = [row.event.padEnd(16, ' '), ts];
  if (row.ruleId) parts.push(`rule=${row.ruleId}`);
  if (row.toTier) parts.push(`toTier=${row.toTier}`);
  if (row.toStatus) parts.push(`toStatus=${row.toStatus}`);
  return parts.join('  ');
}

function dryRunExitCode(state: ImportState): number {
  // Dry-run halts before critic; anything reaching `dry_run_done` is a
  // clean exit. `rejected` states before that indicate the importer
  // short-circuited (fetch / scan / quarantine failure) — non-zero so
  // scripts can chain on it.
  if (state.kind === 'dry_run_done') return 0;
  if (state.kind === 'rejected') return 1;
  return 0;
}

// Named exports for tests.
export { buildCliImporterHandle, parseFlags, pickAdapter };
