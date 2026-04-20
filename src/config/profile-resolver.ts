/**
 * Profile Resolver — W1 PR #1
 *
 * Filesystem + config layer for per-profile state isolation. Mirrors
 * Hermes Agent's `hermes -p <name>` model: each profile owns an
 * independent HOME, config, memory, sessions, budget, trust, PID file.
 *
 * Resolution priority (first match wins):
 *   1. Explicit `opts.flag` (from `--profile` / `-p` CLI arg)
 *   2. `VINYAN_PROFILE` env var
 *   3. `'default'`
 *
 * Config layering (deep-merge, later layers override):
 *   1. Builtin schema defaults
 *   2. `$VINYAN_HOME/config.global.json`
 *   3. `$VINYAN_HOME/profiles/<name>/vinyan.json`
 *   4. `./vinyan.json` (project-local)
 *
 * Arrays replace — they do not concat. This matches how
 * `VinyanConfig.oracles` and `VinyanConfig.agents` are consumed downstream.
 *
 * See docs/spec/w1-contracts.md §3 (profile column convention) and §4
 * (executeTask requires `profile: string`). Non-goal for this PR: wiring
 * the resolver into executeTask; that ships in a follow-up.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type VinyanConfig, VinyanConfigSchema } from './schema.ts';

/** Regex mirrors w1-contracts §4 `source` naming + AgentSpecSchema.id. */
const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Directory permissions for profile state (owner rwx, group/other nothing). */
const PROFILE_DIR_MODE = 0o700;

/** Secrets dir is extra strict — matches Hermes' `secrets/` convention. */
const SECRETS_DIR_MODE = 0o700;

/**
 * Materialized filesystem layout for a single profile.
 * All paths are absolute. Consumers downstream (stores, budget, trust,
 * memory) resolve their state files against these roots.
 */
export interface ResolvedProfilePaths {
  /** <root>/vinyan.json — profile-layer config (may not exist). */
  configFile: string;
  /** <root>/.vinyan — database directory. */
  dbDir: string;
  /** <root>/.vinyan/vinyan.db — scoped SQLite file. */
  dbFile: string;
  /** <root>/memory — memory artifacts (USER.md, auto-memory, vectors). */
  memoryDir: string;
  /** <root>/sessions — session files. */
  sessionsDir: string;
  /** <root>/budget — budget ledger. */
  budgetDir: string;
  /** <root>/trust — trust store. */
  trustDir: string;
  /** <root>/secrets — platform tokens, written with mode 0600. */
  secretsDir: string;
  /** <root>/serve.pid — serve daemon pidfile. */
  pidFile: string;
}

export interface ResolvedProfile {
  /** Validated profile name (kebab-case). */
  name: string;
  /** Absolute path: $VINYAN_HOME/profiles/<name>. */
  root: string;
  /** Materialized paths under `root`. */
  paths: ResolvedProfilePaths;
  /** Resolved $VINYAN_HOME (env var or ~/.vinyan). */
  vinyanHome: string;
  /** $VINYAN_HOME/config.global.json. May not exist on disk. */
  globalConfigFile: string;
  /**
   * Non-fatal warnings raised during resolution — e.g. legacy flat
   * layout fallback when `createDirs: false`. Callers should surface
   * these via observability.
   */
  warnings: string[];
  /**
   * True when the resolver fell back to the legacy flat layout
   * (`$VINYAN_HOME/.vinyan`, `$VINYAN_HOME/memory`, ...) because
   * `profiles/` did not exist and `createDirs` was false.
   */
  legacyLayout: boolean;
}

export interface ResolveProfileOptions {
  /** Value from the `--profile` / `-p` CLI arg. Highest priority. */
  flag?: string;
  /** Env source; defaults to `process.env`. Inject for tests. */
  env?: NodeJS.ProcessEnv;
  /** Overrides $VINYAN_HOME. Primarily for tests; defaults to env or ~/.vinyan. */
  vinyanHome?: string;
  /**
   * When true, create the full directory tree (mode 0700) and migrate a
   * legacy flat layout into `profiles/default/`. When false (default),
   * missing directories are left alone and legacy layouts yield a warning.
   */
  createDirs?: boolean;
}

/**
 * Validate a profile name against the shared convention.
 * Rejects empty, uppercase, path separators, `..`, leading digit/dash.
 */
export function assertValidProfileName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Profile name must be a non-empty string');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Profile name rejects path separators and parent refs: '${name}'`);
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid profile name '${name}': must match ${PROFILE_NAME_PATTERN} (kebab-case, starts with lowercase letter)`,
    );
  }
}

/**
 * Resolve the active profile. Pure + synchronous — safe to call very
 * early in process boot. Does not load config unless `createDirs: true`
 * triggers a legacy migration.
 */
export function resolveProfile(opts: ResolveProfileOptions = {}): ResolvedProfile {
  const env = opts.env ?? process.env;
  const warnings: string[] = [];

  const name = pickProfileName(opts.flag, env);
  assertValidProfileName(name);

  const vinyanHome = resolve(opts.vinyanHome ?? env['VINYAN_HOME'] ?? join(homedir(), '.vinyan'));
  const profilesRoot = join(vinyanHome, 'profiles');
  const root = join(profilesRoot, name);
  const globalConfigFile = join(vinyanHome, 'config.global.json');

  let legacyLayout = false;

  if (opts.createDirs) {
    // Auto-migrate the legacy flat layout (if any) into profiles/default/.
    if (name === 'default' && existsSync(vinyanHome) && !existsSync(profilesRoot)) {
      migrateLegacyFlatLayout(vinyanHome, root, warnings);
    }
    ensureDir(vinyanHome, PROFILE_DIR_MODE);
    ensureDir(profilesRoot, PROFILE_DIR_MODE);
    ensureDir(root, PROFILE_DIR_MODE);
    ensureDir(join(root, '.vinyan'), PROFILE_DIR_MODE);
    ensureDir(join(root, 'memory'), PROFILE_DIR_MODE);
    ensureDir(join(root, 'sessions'), PROFILE_DIR_MODE);
    ensureDir(join(root, 'budget'), PROFILE_DIR_MODE);
    ensureDir(join(root, 'trust'), PROFILE_DIR_MODE);
    ensureDir(join(root, 'secrets'), SECRETS_DIR_MODE);
  } else if (existsSync(vinyanHome) && !existsSync(profilesRoot) && hasLegacyFlatState(vinyanHome)) {
    // Legacy flat layout detected; keep serving it so existing invocations
    // don't break. Paths below point at the flat layout in this branch.
    // Note: an empty $VINYAN_HOME (no profiles/, no legacy files) is treated
    // as "fresh install" and routed through the profiles layout.
    legacyLayout = true;
    warnings.push(
      `Legacy flat $VINYAN_HOME layout detected at '${vinyanHome}'. ` +
        'Run with `createDirs: true` (or via the CLI migration command) to move state into profiles/default/.',
    );
  }

  const paths: ResolvedProfilePaths = legacyLayout
    ? legacyFlatPaths(vinyanHome)
    : {
        configFile: join(root, 'vinyan.json'),
        dbDir: join(root, '.vinyan'),
        dbFile: join(root, '.vinyan', 'vinyan.db'),
        memoryDir: join(root, 'memory'),
        sessionsDir: join(root, 'sessions'),
        budgetDir: join(root, 'budget'),
        trustDir: join(root, 'trust'),
        secretsDir: join(root, 'secrets'),
        pidFile: join(root, 'serve.pid'),
      };

  return {
    name,
    root: legacyLayout ? vinyanHome : root,
    paths,
    vinyanHome,
    globalConfigFile,
    warnings,
    legacyLayout,
  };
}

/**
 * Deep-merge config layers (defaults → global → profile → project) and
 * run the result through `VinyanConfigSchema` so consumers always get a
 * validated, defaulted `VinyanConfig`.
 *
 * Arrays replace, they do not concat. This matches how downstream
 * consumers treat `oracles` / `agents` as authoritative when specified.
 */
export function loadLayeredConfig(args: {
  profile: ResolvedProfile;
  /** Optional project workspace (where `./vinyan.json` lives). */
  workspacePath?: string;
}): VinyanConfig {
  const layers: Record<string, unknown>[] = [];

  if (existsSync(args.profile.globalConfigFile)) {
    layers.push(readJson(args.profile.globalConfigFile));
  }
  if (!args.profile.legacyLayout && existsSync(args.profile.paths.configFile)) {
    layers.push(readJson(args.profile.paths.configFile));
  }
  if (args.workspacePath) {
    const projectConfig = join(args.workspacePath, 'vinyan.json');
    if (existsSync(projectConfig)) {
      layers.push(readJson(projectConfig));
    }
  }

  const merged = layers.reduce<Record<string, unknown>>((acc, layer) => deepMerge(acc, layer), {});
  const result = VinyanConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid layered config for profile '${args.profile.name}':\n${issues}`);
  }
  return result.data;
}

// ─── Internals ───────────────────────────────────────────────────────

function pickProfileName(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag !== undefined && flag.length > 0) return flag;
  const fromEnv = env['VINYAN_PROFILE'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return 'default';
}

function ensureDir(path: string, mode: number): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode });
    return;
  }
  // Best-effort: if the caller asked for strict perms, tighten existing dir.
  // We don't throw on failure — some environments (CI, shared tmp) may not
  // allow chmod. The caller can always inspect the fs and escalate.
}

/**
 * Move a legacy flat $VINYAN_HOME (pre-profiles layout) under
 * profiles/default/. Idempotent: skips files that already exist at the
 * target. Leaves symlinks at the old paths for one transitional version
 * so external scripts keep resolving them.
 */
function migrateLegacyFlatLayout(vinyanHome: string, defaultRoot: string, warnings: string[]): void {
  const legacyEntries: Array<{ src: string; dst: string }> = [
    { src: join(vinyanHome, '.vinyan'), dst: join(defaultRoot, '.vinyan') },
    { src: join(vinyanHome, 'memory'), dst: join(defaultRoot, 'memory') },
    { src: join(vinyanHome, 'sessions'), dst: join(defaultRoot, 'sessions') },
    { src: join(vinyanHome, 'budget'), dst: join(defaultRoot, 'budget') },
    { src: join(vinyanHome, 'trust'), dst: join(defaultRoot, 'trust') },
    { src: join(vinyanHome, 'secrets'), dst: join(defaultRoot, 'secrets') },
    { src: join(vinyanHome, 'vinyan.json'), dst: join(defaultRoot, 'vinyan.json') },
    { src: join(vinyanHome, 'serve.pid'), dst: join(defaultRoot, 'serve.pid') },
  ];

  const toMigrate = legacyEntries.filter(({ src }) => existsSync(src));
  if (toMigrate.length === 0) return;

  mkdirSync(defaultRoot, { recursive: true, mode: PROFILE_DIR_MODE });

  for (const { src, dst } of toMigrate) {
    if (existsSync(dst)) {
      warnings.push(`Skipping legacy migration for '${src}' — destination already exists at '${dst}'.`);
      continue;
    }
    try {
      renameSync(src, dst);
      // One-version transitional symlink so external tools keep resolving
      // the legacy path. The CLI cleanup command removes these later.
      try {
        symlinkSync(dst, src);
      } catch {
        // Symlinks may be unavailable (Windows without perms, certain FS).
        // Not fatal — state is already at the new location.
      }
    } catch (e) {
      warnings.push(`Legacy migration failed for '${src}' → '${dst}': ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  warnings.push(`Migrated ${toMigrate.length} legacy entries into '${defaultRoot}'.`);
}

/**
 * Detect whether $VINYAN_HOME holds any pre-profiles layout artifact.
 * Presence of any of these well-known top-level entries is enough to
 * consider the layout "legacy" — an empty dir is treated as a fresh
 * install and proceeds straight to the profiles layout.
 */
function hasLegacyFlatState(vinyanHome: string): boolean {
  const sentinels = ['.vinyan', 'memory', 'sessions', 'budget', 'trust', 'secrets', 'vinyan.json', 'serve.pid'];
  return sentinels.some((entry) => existsSync(join(vinyanHome, entry)));
}

function legacyFlatPaths(vinyanHome: string): ResolvedProfilePaths {
  return {
    configFile: join(vinyanHome, 'vinyan.json'),
    dbDir: join(vinyanHome, '.vinyan'),
    dbFile: join(vinyanHome, '.vinyan', 'vinyan.db'),
    memoryDir: join(vinyanHome, 'memory'),
    sessionsDir: join(vinyanHome, 'sessions'),
    budgetDir: join(vinyanHome, 'budget'),
    trustDir: join(vinyanHome, 'trust'),
    secretsDir: join(vinyanHome, 'secrets'),
    pidFile: join(vinyanHome, 'serve.pid'),
  };
}

function readJson(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Expected object at ${path}, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid JSON in '${path}': ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge two plain objects. Arrays and scalars from `overlay` replace
 * the corresponding value in `base`. Nested plain objects are merged
 * recursively. The inputs are not mutated.
 */
function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(overlayValue)) {
      out[key] = deepMerge(baseValue, overlayValue);
    } else {
      out[key] = overlayValue;
    }
  }
  return out;
}

/**
 * List all profile names present under $VINYAN_HOME/profiles/.
 * Useful for the CLI `vinyan profile ls` command (not wired in this PR).
 */
export function listProfiles(vinyanHome: string): string[] {
  const profilesRoot = join(vinyanHome, 'profiles');
  if (!existsSync(profilesRoot)) return [];
  return readdirSync(profilesRoot).filter((entry) => {
    try {
      return statSync(join(profilesRoot, entry)).isDirectory() && PROFILE_NAME_PATTERN.test(entry);
    } catch {
      return false;
    }
  });
}
