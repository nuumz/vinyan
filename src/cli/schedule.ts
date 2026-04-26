/**
 * `vinyan schedule` — user-facing CLI for W3 H3 natural-language cron.
 *
 * Subcommands:
 *   - `create "<nl-text>"`  Parse + persist a schedule (non-zero on failure).
 *   - `list`                Enumerate active schedules for the profile.
 *   - `show <id>`           Dump the full tuple JSON.
 *   - `delete <id>`         Soft-delete (flips status to `expired`).
 *
 * Wiring:
 *   - DB: VinyanDB scoped to the resolved profile; migrations applied on
 *     open so the `gateway_schedules` table exists.
 *   - Goal-alignment oracle: CLI stub from `./oracle-stubs.ts` (TODO W4).
 *   - Cron parsing + interpretation: library-stable, imported as-is from
 *     `src/gateway/scheduling/`.
 *
 * Design: handlers are exported as plain async functions over `argv`
 * slices so unit tests can drive them directly. `runScheduleCommand` is
 * the dispatch entry point the top-level `vinyan` binary calls.
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { resolveProfile } from '../config/profile-resolver.ts';
import { GatewayScheduleStore } from '../db/gateway-schedule-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import {
  interpretSchedule,
  nextFireAt,
  type ScheduledHypothesisTuple,
  type ScheduleOrigin,
  type SchedulingOriginPlatform,
} from '../gateway/scheduling/index.ts';
import { classifyScheduleStrategy } from '../orchestrator/intent-resolver.ts';
import { stubGoalAlignmentOracle } from './oracle-stubs.ts';

const DEFAULT_TIMEZONE = 'Asia/Bangkok';
const VALID_PLATFORMS: ReadonlySet<SchedulingOriginPlatform> = new Set([
  'telegram',
  'slack',
  'discord',
  'whatsapp',
  'signal',
  'email',
  'cli',
]);

export interface ScheduleCommandDeps {
  /** Inject a pre-opened SQLite handle (tests use `:memory:`). */
  readonly db?: Database;
  /** Inject a profile name override (skips filesystem resolution). */
  readonly profile?: string;
  /** Inject a deterministic clock. */
  readonly clock?: () => number;
  /** Inject a deterministic UUID generator. */
  readonly uuid?: () => string;
  /** Inject a deterministic timezone fallback. */
  readonly defaultTimezone?: string;
  /** Capture stdout — defaults to process.stdout.write. */
  readonly stdout?: (chunk: string) => void;
  /** Capture stderr — defaults to process.stderr.write. */
  readonly stderr?: (chunk: string) => void;
  /** Override process.exit so tests can assert without crashing the runner. */
  readonly exit?: (code: number) => never;
}

interface Ctx {
  readonly db: Database;
  readonly profile: string;
  readonly clock: () => number;
  readonly uuid: () => string;
  readonly defaultTimezone: string;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly ownsDb: boolean;
}

function buildCtx(deps: ScheduleCommandDeps = {}): Ctx {
  const ownsDb = deps.db === undefined;
  let db: Database;
  let profile: string;
  if (deps.db) {
    db = deps.db;
    profile = deps.profile ?? 'default';
  } else {
    const resolved = resolveProfile(deps.profile !== undefined ? { flag: deps.profile } : {});
    const vdb = new VinyanDB(resolved.paths.dbFile);
    db = vdb.getDb();
    profile = resolved.name;
    // VinyanDB wrapper is only used for migrations; the Database handle is
    // sufficient for the rest of the command. The wrapper is not stored
    // because the CLI process exits immediately after the command runs and
    // SQLite will flush on close via the raw handle below.
  }
  return {
    db,
    profile,
    clock: deps.clock ?? (() => Date.now()),
    uuid: deps.uuid ?? (() => randomUUID()),
    defaultTimezone: deps.defaultTimezone ?? DEFAULT_TIMEZONE,
    stdout: deps.stdout ?? ((c) => process.stdout.write(c)),
    stderr: deps.stderr ?? ((c) => process.stderr.write(c)),
    exit: deps.exit ?? ((code: number) => process.exit(code)),
    ownsDb,
  };
}

function printUsage(write: (chunk: string) => void): void {
  write(
    `vinyan schedule — natural-language cron\n\n` +
      `Subcommands:\n` +
      `  create "<nl-text>"  [--platform <p>] [--chat-id <id>] [--profile <p>]\n` +
      `  list                                [--profile <p>]\n` +
      `  show   <id>                         [--profile <p>]\n` +
      `  delete <id>                         [--profile <p>]\n`,
  );
}

export async function runScheduleCommand(args: readonly string[], deps: ScheduleCommandDeps = {}): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printUsage(deps.stdout ?? ((c) => process.stdout.write(c)));
    return;
  }

  const ctx = buildCtx(deps);
  try {
    switch (sub) {
      case 'create':
        await handleCreate(ctx, args.slice(1));
        return;
      case 'list':
        await handleList(ctx, args.slice(1));
        return;
      case 'show':
        await handleShow(ctx, args.slice(1));
        return;
      case 'delete':
        await handleDelete(ctx, args.slice(1));
        return;
      default:
        ctx.stderr(`Unknown schedule subcommand: ${sub}\n`);
        printUsage(ctx.stderr);
        ctx.exit(1);
        return;
    }
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

interface CreateFlags {
  nlText?: string;
  platform: SchedulingOriginPlatform;
  chatId: string | null;
}

function parseCreateFlags(ctx: Ctx, args: readonly string[]): CreateFlags {
  const flags: CreateFlags = { platform: 'cli', chatId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--platform') {
      const v = args[++i];
      if (!v) {
        ctx.stderr('Missing value for --platform\n');
        ctx.exit(2);
      }
      if (!VALID_PLATFORMS.has(v as SchedulingOriginPlatform)) {
        ctx.stderr(`Unknown platform: ${v}\n`);
        ctx.exit(2);
      }
      flags.platform = v as SchedulingOriginPlatform;
      continue;
    }
    if (a === '--chat-id') {
      const v = args[++i];
      if (!v) {
        ctx.stderr('Missing value for --chat-id\n');
        ctx.exit(2);
      }
      flags.chatId = v;
      continue;
    }
    if (a === '--profile' || a === '-p') {
      // Already consumed by buildCtx via opts.profile; skip value.
      i++;
      continue;
    }
    if (a?.startsWith('--profile=')) {
      continue;
    }
    if (a?.startsWith('--')) {
      ctx.stderr(`Unknown flag: ${a}\n`);
      ctx.exit(2);
    }
    if (flags.nlText === undefined) {
      flags.nlText = a;
    }
  }
  return flags;
}

async function handleCreate(ctx: Ctx, args: readonly string[]): Promise<void> {
  const flags = parseCreateFlags(ctx, args);
  if (!flags.nlText) {
    ctx.stderr('Missing natural-language schedule text\n');
    printUsage(ctx.stderr);
    ctx.exit(2);
    return;
  }

  // Step 1: confirm the text is actually a schedule request.
  const classification = classifyScheduleStrategy({ goal: flags.nlText });
  if (!classification) {
    ctx.stderr(
      `Not a schedule request: "${flags.nlText}"\n` +
        `Expected natural-language cron (e.g. "every weekday at 9am summarize PRs").\n`,
    );
    ctx.exit(1);
    return;
  }

  // Step 2: run the H3 interpreter.
  const origin: ScheduleOrigin = { platform: flags.platform, chatId: flags.chatId };
  const result = await interpretSchedule(classification.scheduleText, origin, ctx.profile, {
    goalAlignmentOracle: stubGoalAlignmentOracle(),
    defaultTimezone: ctx.defaultTimezone,
    clock: ctx.clock,
  });
  if (!result.ok) {
    ctx.stderr(`Schedule interpretation failed (${result.reason}): ${result.detail}\n`);
    ctx.exit(1);
    return;
  }

  // Step 3: materialize the full tuple.
  const now = ctx.clock();
  const id = ctx.uuid();
  const fireAt = nextFireAt(result.tuple.cron, result.tuple.timezone, now);
  const hash = createHash('sha256')
    .update(
      `${result.tuple.goal}|${result.tuple.cron}|${result.tuple.timezone}|${origin.platform}|${origin.chatId ?? ''}`,
    )
    .digest('hex');
  const tuple: ScheduledHypothesisTuple = {
    ...result.tuple,
    id,
    createdAt: now,
    evidenceHash: hash,
    nextFireAt: fireAt,
    status: 'active',
    failureStreak: 0,
    runHistory: [],
  };
  const store = new GatewayScheduleStore(ctx.db);
  store.save(tuple);

  // Step 4: report.
  ctx.stdout(`Schedule created: ${id}\n`);
  ctx.stdout(`  cron:     ${tuple.cron}  (tz: ${tuple.timezone})\n`);
  ctx.stdout(`  goal:     ${tuple.goal}\n`);
  ctx.stdout(`  next run: ${new Date(fireAt).toISOString()}  (${formatRelative(fireAt - now)})\n`);
  ctx.stdout(`  profile:  ${ctx.profile}\n`);
}

async function handleList(ctx: Ctx, _args: readonly string[]): Promise<void> {
  // The store's `listDueBefore` filters on `status = 'active'`, which
  // would hide paused/expired/failed-circuit rows from a `vinyan schedule
  // list`. We need the full profile-scoped set here, so issue a thin
  // direct query against the table that the store is the owner of — the
  // column surface is stable under migration 006.
  interface ListRow {
    id: string;
    cron: string;
    timezone: string;
    goal: string;
    status: string;
    next_fire_at: number | null;
  }
  // SQLite sorts NULLs first by default on ASC — put them last via a
  // synthetic rank column so cleared-out schedules don't jump ahead of
  // active ones.
  const rows = ctx.db
    .prepare(
      `SELECT id, cron, timezone, goal, status, next_fire_at
         FROM gateway_schedules
        WHERE profile = ?
        ORDER BY (next_fire_at IS NULL) ASC, next_fire_at ASC`,
    )
    .all(ctx.profile) as ListRow[];

  if (rows.length === 0) {
    ctx.stdout(`No schedules for profile "${ctx.profile}".\n`);
    return;
  }

  ctx.stdout(`Schedules (profile: ${ctx.profile}):\n`);
  for (const s of rows) {
    const next = s.next_fire_at ? new Date(s.next_fire_at).toISOString() : '—';
    const goal = s.goal.length > 40 ? `${s.goal.slice(0, 37)}...` : s.goal;
    ctx.stdout(`  ${s.id}  ${s.cron}  tz=${s.timezone}  status=${s.status}  next=${next}  goal="${goal}"\n`);
  }
}

async function handleShow(ctx: Ctx, args: readonly string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    ctx.stderr('Missing schedule id\n');
    ctx.exit(2);
    return;
  }
  const store = new GatewayScheduleStore(ctx.db);
  const tuple = store.get(id, ctx.profile);
  if (!tuple) {
    ctx.stderr(`Schedule ${id} not found in profile ${ctx.profile}\n`);
    ctx.exit(1);
    return;
  }
  ctx.stdout(`${JSON.stringify(tuple, null, 2)}\n`);
}

async function handleDelete(ctx: Ctx, args: readonly string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    ctx.stderr('Missing schedule id\n');
    ctx.exit(2);
    return;
  }
  const store = new GatewayScheduleStore(ctx.db);
  const existing = store.get(id, ctx.profile);
  if (!existing) {
    ctx.stderr(`Schedule ${id} not found in profile ${ctx.profile}\n`);
    ctx.exit(1);
    return;
  }
  // Soft-delete via the status flip — `expired` stops the runner from
  // picking the tuple up on the next tick without losing history.
  store.setStatus(id, ctx.profile, 'expired');
  ctx.stdout(`Schedule ${id} marked expired.\n`);
}

function formatRelative(deltaMs: number): string {
  if (deltaMs < 0) return 'past';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `in ${day}d ${hr % 24}h`;
}
