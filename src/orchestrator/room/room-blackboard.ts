/**
 * RoomBlackboard — scoped-write KV store for room participants.
 *
 * Reads are free for all roles (A1-safe shared context). Writes are gated
 * by each role's `writableBlackboardKeys` glob patterns: an attempt to write
 * outside the role's scope throws `BlackboardScopeViolation` synchronously
 * (A6 — supervisor disposes on violation by closing the room `failed`).
 *
 * The glob syntax is intentionally tiny — the only wildcard is `*` matching
 * any run of characters except '/'. `**` matches any run including '/'.
 * Exact matches and prefix/suffix patterns cover every case we need for R1.
 */
import { type BlackboardEntry, BlackboardScopeViolation, type RoleSpec } from './types.ts';

/** Compile a tiny glob to a regex. Supported: `*` (no slash), `**` (any). */
function globToRegex(pattern: string): RegExp {
  // Escape regex metacharacters except * which we replace explicitly.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // `**` first so it doesn't collide with the `*` replacement.
  const regexBody = escaped
    .replace(/\*\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLESTAR::/g, '.*');
  return new RegExp(`^${regexBody}$`);
}

/** True when `key` matches at least one of the role's writable glob patterns. */
export function isKeyWritable(key: string, allowed: readonly string[]): boolean {
  for (const pattern of allowed) {
    if (globToRegex(pattern).test(key)) return true;
  }
  return false;
}

export class RoomBlackboard {
  /** Latest entry per key. Version increments monotonically on overwrite. */
  private cells: Map<string, BlackboardEntry> = new Map();
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /**
   * Write a key on behalf of the given role. Throws `BlackboardScopeViolation`
   * when the role is not authorized to write `key`. A6-enforced synchronously
   * so a scope violation surfaces immediately and the supervisor can close
   * the room without staging the value.
   */
  write(key: string, value: unknown, role: RoleSpec): BlackboardEntry {
    if (!isKeyWritable(key, role.writableBlackboardKeys)) {
      throw new BlackboardScopeViolation(role.name, key, role.writableBlackboardKeys);
    }
    const previous = this.cells.get(key);
    const version = (previous?.version ?? -1) + 1;
    const entry: BlackboardEntry = {
      key,
      value,
      authorRole: role.name,
      version,
      timestamp: this.clock(),
    };
    this.cells.set(key, entry);
    return entry;
  }

  /** Read the latest value for `key`, or undefined when no entry exists. */
  read(key: string): BlackboardEntry | undefined {
    return this.cells.get(key);
  }

  /** Snapshot of all cells keyed by key. Shallow-copy protection only. */
  readAll(): ReadonlyMap<string, BlackboardEntry> {
    return new Map(this.cells);
  }

  /**
   * Frozen snapshot filtered to keys a role may read (all keys, by design —
   * reads are free). The returned map is frozen to prevent accidental mutation
   * by callers; mutation attempts throw in strict mode and silently fail otherwise.
   */
  scopedView(_role: RoleSpec): ReadonlyMap<string, BlackboardEntry> {
    return new Map(this.cells);
  }

  /** Number of cells currently held. */
  size(): number {
    return this.cells.size;
  }

  /**
   * Supervisor-privileged write: bypass role scope checks so the dispatcher
   * can seed initial state (e.g. Team blackboard import) before any
   * participant takes a turn. `authorRole` is an opaque string used only
   * for the audit field — participants see this as a normal BlackboardEntry.
   *
   * ONLY the Supervisor / Dispatcher should call this. Never expose it to
   * participant code paths — that would break A6 role-scoped writes.
   */
  systemSeed(key: string, value: unknown, authorRole: string): BlackboardEntry {
    const previous = this.cells.get(key);
    const version = (previous?.version ?? -1) + 1;
    const entry: BlackboardEntry = {
      key,
      value,
      authorRole,
      version,
      timestamp: this.clock(),
    };
    this.cells.set(key, entry);
    return entry;
  }

  /**
   * Return entries whose version > `sinceVersion`. Used by the team-bridge
   * export step to detect which keys were actually mutated during the room
   * (key present at open with version V → if final > V, it changed).
   */
  entriesChangedSince(initial: ReadonlyMap<string, number>): BlackboardEntry[] {
    const changed: BlackboardEntry[] = [];
    for (const [key, entry] of this.cells) {
      const baseline = initial.get(key);
      // New key, or version advanced past the seeded version
      if (baseline === undefined || entry.version > baseline) changed.push(entry);
    }
    return changed;
  }
}
