/**
 * User Preference Store — tracks user app/tool preferences learned from usage.
 *
 * When a user says "แอพ mail" and the system opens Gmail, record the preference:
 *   category=mail → preferred_app=gmail, command="open https://mail.google.com"
 *
 * Lifecycle: probation (usage_count < PROMOTION_THRESHOLD) → active.
 * Active preferences are injected into the intent-resolver LLM prompt to bias
 * future resolutions toward the user's proven preference.
 *
 * A7 compliance: Prediction error as learning — records actual user behavior
 * to improve future predictions.
 *
 * Schema is self-initialized (CREATE TABLE IF NOT EXISTS) — no migration needed.
 * Follows dual-write pattern (memory + SQLite) consistent with ProviderTrustStore.
 */
import type { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserPreference {
  category: string;
  preferredApp: string;
  resolvedCommand: string;
  usageCount: number;
  lastUsedAt: number;
  status: 'probation' | 'active';
}

// ---------------------------------------------------------------------------
// App → Category mapping
// ---------------------------------------------------------------------------

const APP_CATEGORY_MAP = new Map<string, string>([
  // Mail
  ['gmail', 'mail'], ['mail', 'mail'], ['outlook', 'mail'], ['thunderbird', 'mail'],
  ['protonmail', 'mail'], ['yahoo mail', 'mail'], ['hotmail', 'mail'],

  // Browser
  ['chrome', 'browser'], ['google chrome', 'browser'], ['firefox', 'browser'],
  ['safari', 'browser'], ['brave', 'browser'], ['edge', 'browser'], ['arc', 'browser'],
  ['opera', 'browser'],

  // Music
  ['spotify', 'music'], ['apple music', 'music'], ['youtube music', 'music'],

  // Chat/Communication
  ['slack', 'chat'], ['discord', 'chat'], ['teams', 'chat'], ['microsoft teams', 'chat'],
  ['line', 'chat'], ['telegram', 'chat'], ['zoom', 'video-call'],

  // Editor
  ['vscode', 'editor'], ['visual studio code', 'editor'], ['cursor', 'editor'],
  ['vim', 'editor'], ['neovim', 'editor'], ['sublime', 'editor'],

  // Notes
  ['notion', 'notes'], ['obsidian', 'notes'], ['notes', 'notes'], ['onenote', 'notes'],
  ['bear', 'notes'], ['evernote', 'notes'],

  // Calendar
  ['calendar', 'calendar'], ['google calendar', 'calendar'], ['fantastical', 'calendar'],

  // Terminal
  ['terminal', 'terminal'], ['iterm', 'terminal'], ['iterm2', 'terminal'],
  ['warp', 'terminal'], ['alacritty', 'terminal'], ['kitty', 'terminal'],

  // File manager
  ['finder', 'file-manager'],

  // Office
  ['word', 'word-processor'], ['microsoft word', 'word-processor'],
  ['excel', 'spreadsheet'], ['microsoft excel', 'spreadsheet'],
  ['powerpoint', 'presentation'], ['microsoft powerpoint', 'presentation'],
]);

/** Category keywords — when user says "แอพ <keyword>", map to a category. */
const CATEGORY_KEYWORDS = new Map<string, string>([
  ['mail', 'mail'], ['email', 'mail'], ['อีเมล', 'mail'], ['เมล', 'mail'],
  ['browser', 'browser'], ['เบราว์เซอร์', 'browser'],
  ['music', 'music'], ['เพลง', 'music'],
  ['chat', 'chat'], ['แชท', 'chat'],
  ['editor', 'editor'], ['โค้ด', 'editor'],
  ['notes', 'notes'], ['โน้ต', 'notes'],
  ['calendar', 'calendar'], ['ปฏิทิน', 'calendar'],
  ['terminal', 'terminal'], ['เทอร์มินัล', 'terminal'],
]);

/**
 * Detect app category from a goal string or app name.
 * Returns the category if recognized, undefined otherwise.
 */
export function detectAppCategory(appNameOrGoal: string): string | undefined {
  const normalized = appNameOrGoal.toLowerCase().trim();

  // Direct app name → category
  const direct = APP_CATEGORY_MAP.get(normalized);
  if (direct) return direct;

  // Category keyword
  const keyword = CATEGORY_KEYWORDS.get(normalized);
  if (keyword) return keyword;

  // Check if any known app name is a substring
  for (const [appName, category] of APP_CATEGORY_MAP) {
    if (normalized.includes(appName)) return category;
  }

  // Check category keywords in goal text
  for (const [kw, category] of CATEGORY_KEYWORDS) {
    if (normalized.includes(kw)) return category;
  }

  return undefined;
}

/**
 * Extract the specific app name from a goal if the user mentioned one.
 * Returns the normalized app name, or undefined if only a category was mentioned.
 *
 * Examples:
 *   "เปิด Gmail" → "gmail"
 *   "open Outlook" → "outlook"
 *   "แอพ mail" → undefined (category, not specific app)
 */
export function extractSpecificApp(goal: string): string | undefined {
  const normalized = goal.toLowerCase().trim();

  // Check if any specific app name is in the goal
  for (const [appName] of APP_CATEGORY_MAP) {
    if (appName.length >= 3 && normalized.includes(appName)) {
      // Exclude generic category words that are also in APP_CATEGORY_MAP
      if (CATEGORY_KEYWORDS.has(appName)) continue;
      return appName;
    }
  }

  return undefined;
}

/**
 * Check if a goal refers to a category rather than a specific app.
 * Returns true for "แอพ mail", false for "เปิด Gmail".
 */
export function isGoalCategoryLevel(goal: string): boolean {
  return extractSpecificApp(goal) === undefined && detectAppCategory(goal) !== undefined;
}

/**
 * Get all known app names that belong to a category.
 * Useful for disambiguation prompts.
 */
export function getAppsInCategory(category: string): string[] {
  const apps: string[] = [];
  const seen = new Set<string>();
  for (const [appName, cat] of APP_CATEGORY_MAP) {
    if (cat === category && !seen.has(appName) && !CATEGORY_KEYWORDS.has(appName)) {
      seen.add(appName);
      apps.push(appName);
    }
  }
  return apps;
}

// ---------------------------------------------------------------------------
// Promotion threshold — how many successful uses before "active"
// ---------------------------------------------------------------------------

const PROMOTION_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class UserPreferenceStore {
  private db: Database;
  private cache = new Map<string, UserPreference>();

  constructor(db: Database) {
    this.db = db;
    this.initSchema();
    this.warmCache();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_app_preferences (
        category TEXT PRIMARY KEY,
        preferred_app TEXT NOT NULL,
        resolved_command TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 1,
        last_used_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('probation', 'active')) DEFAULT 'probation'
      )
    `);
  }

  private warmCache(): void {
    const rows = this.db
      .prepare('SELECT category, preferred_app, resolved_command, usage_count, last_used_at, status FROM user_app_preferences')
      .all() as Array<{
        category: string;
        preferred_app: string;
        resolved_command: string;
        usage_count: number;
        last_used_at: number;
        status: string;
      }>;
    for (const row of rows) {
      this.cache.set(row.category, {
        category: row.category,
        preferredApp: row.preferred_app,
        resolvedCommand: row.resolved_command,
        usageCount: row.usage_count,
        lastUsedAt: row.last_used_at,
        status: row.status as 'probation' | 'active',
      });
    }
  }

  /**
   * Record a successful app usage. If the app changes for a category,
   * reset usage count and put back into probation.
   */
  recordUsage(category: string, preferredApp: string, resolvedCommand: string): void {
    const existing = this.cache.get(category);
    const now = Date.now();

    if (existing && existing.preferredApp === preferredApp) {
      // Same app as before — increment usage
      existing.usageCount++;
      existing.lastUsedAt = now;
      existing.resolvedCommand = resolvedCommand;
      if (existing.status === 'probation' && existing.usageCount >= PROMOTION_THRESHOLD) {
        existing.status = 'active';
      }
    } else {
      // New or different app — start fresh in probation
      this.cache.set(category, {
        category,
        preferredApp,
        resolvedCommand,
        usageCount: 1,
        lastUsedAt: now,
        status: 'probation',
      });
    }

    const pref = this.cache.get(category)!;
    try {
      this.db.run(
        `INSERT INTO user_app_preferences (category, preferred_app, resolved_command, usage_count, last_used_at, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(category) DO UPDATE SET
           preferred_app = excluded.preferred_app,
           resolved_command = excluded.resolved_command,
           usage_count = excluded.usage_count,
           last_used_at = excluded.last_used_at,
           status = excluded.status`,
        [pref.category, pref.preferredApp, pref.resolvedCommand, pref.usageCount, pref.lastUsedAt, pref.status],
      );
    } catch {
      // Memory cache is authoritative — DB write failure is non-fatal
    }
  }

  /** Get the preference for a category. Returns undefined if none recorded. */
  getPreference(category: string): UserPreference | undefined {
    return this.cache.get(category);
  }

  /** Get all active preferences (for prompt injection). */
  getActivePreferences(): UserPreference[] {
    return Array.from(this.cache.values()).filter((p) => p.status === 'active');
  }

  /** Get all preferences (including probation). */
  getAllPreferences(): UserPreference[] {
    return Array.from(this.cache.values());
  }

  /** Format active preferences as a human-readable string for LLM prompt injection. */
  formatForPrompt(): string {
    const active = this.getActivePreferences();
    if (active.length === 0) return '';

    const lines = active.map((p) =>
      `- For "${p.category}": user prefers "${p.preferredApp}" (used ${p.usageCount} times)`,
    );
    return `\nUser app preferences (learned from past behavior):\n${lines.join('\n')}`;
  }
}
