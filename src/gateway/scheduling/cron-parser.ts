/**
 * Natural-language → CRON parser (W3 H3 MVP).
 *
 * Recognises a deliberately small NL grammar (see README of this module or
 * the W3 spec in `docs/spec/…`). Anything outside the grammar fails cleanly
 * with `ok: false`. We intentionally avoid pulling a new parser dependency:
 * the patterns we support are enumerable and testable inline.
 *
 * A3 compliance: every decision is a pure function of the input string + a
 * `defaultTimezone` argument. No LLM in this path.
 *
 * Supported NL patterns (MVP):
 *   - "every weekday at 9am"              → `0 9 * * 1-5`
 *   - "every monday at 9:30"              → `30 9 * * 1`
 *   - "daily at 20:00"                    → `0 20 * * *`
 *   - "every hour"                        → `0 * * * *`
 *   - "every 30 minutes"                  → `*​/30 * * * *`
 *   - "at 14:00 on weekends"              → `0 14 * * 6,0`
 *
 * Timezone resolution: the caller's `defaultTimezone` is used unless the
 * text contains a trailing `in <IANA>` clause (e.g. `… in Asia/Bangkok`).
 * Thai/other languages: follow-up work, not MVP.
 */

export interface CronParseResult {
  readonly ok: true;
  readonly cron: string;
  readonly timezone: string;
  readonly matchedPattern: string;
}

export interface CronParseFailure {
  readonly ok: false;
  readonly reason: 'no-pattern-match' | 'ambiguous-time' | 'invalid-timezone';
  readonly detail: string;
}

export interface ParseCronOptions {
  readonly defaultTimezone: string;
}

const DAY_NAME_TO_DOW: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const DAY_NAME_PATTERN =
  '(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)';

/**
 * Parse a constrained NL scheduling clause into a CRON string + timezone.
 *
 * Returns a discriminated union. Callers MUST check `ok` before reading
 * `cron`/`timezone`.
 */
export function parseCron(nl: string, opts: ParseCronOptions): CronParseResult | CronParseFailure {
  const rawLower = nl.trim().toLowerCase();
  if (!rawLower) {
    return { ok: false, reason: 'no-pattern-match', detail: 'empty input' };
  }

  const { text: withoutTz, timezone, tzError } = extractTimezone(rawLower, opts.defaultTimezone);
  if (tzError) {
    return { ok: false, reason: 'invalid-timezone', detail: tzError };
  }

  // 1) "every N minutes" — also tolerates "every 30m" / "every 5 min"
  const everyMinutes = withoutTz.match(/\bevery\s+(\d{1,2})\s*(?:minutes?|mins?|m)\b/);
  if (everyMinutes?.[1]) {
    const n = Number.parseInt(everyMinutes[1], 10);
    if (n < 1 || n > 59) {
      return { ok: false, reason: 'ambiguous-time', detail: `every ${n} minutes is out of range` };
    }
    return {
      ok: true,
      cron: `*/${n} * * * *`,
      timezone,
      matchedPattern: 'every-N-minutes',
    };
  }

  // 2) "every hour"
  if (/\bevery\s+hour\b/.test(withoutTz)) {
    return { ok: true, cron: '0 * * * *', timezone, matchedPattern: 'every-hour' };
  }

  // 3) Time + scope variants. Supported scopes: weekday / weekend / specific day.
  // Patterns (a) "every <scope> at <time>", (b) "at <time> on <scope>",
  // (c) "daily at <time>".
  const scope = extractScope(withoutTz);
  const time = extractTime(withoutTz);

  if (scope && time) {
    return {
      ok: true,
      cron: `${time.minute} ${time.hour} * * ${scope.dow}`,
      timezone,
      matchedPattern: scope.label,
    };
  }

  // 4) "daily at <time>" or bare "at <time>" (treat as daily).
  if (time && /\bdaily\b|\beveryday\b|\bevery\s+day\b|\bat\b/.test(withoutTz)) {
    return {
      ok: true,
      cron: `${time.minute} ${time.hour} * * *`,
      timezone,
      matchedPattern: 'daily',
    };
  }

  if (!time && /\bat\b/.test(withoutTz)) {
    return {
      ok: false,
      reason: 'ambiguous-time',
      detail: `could not extract a concrete time from "${nl}"`,
    };
  }

  return {
    ok: false,
    reason: 'no-pattern-match',
    detail: `no supported scheduling pattern in "${nl}"`,
  };
}

interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * Find the first time-of-day token in the input and return (hour, minute).
 * Accepts: `9am`, `9:30am`, `09:30`, `21:15`, `8 pm`, `at 14:00`.
 */
function extractTime(text: string): TimeOfDay | null {
  // 24h: "14:00", "09:30".
  const h24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (h24?.[1] && h24[2]) {
    return { hour: Number.parseInt(h24[1], 10), minute: Number.parseInt(h24[2], 10) };
  }

  // 12h with optional :MM: "9am", "9:30am", "8 pm".
  const h12 = text.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (h12?.[1] && h12[3]) {
    let hour = Number.parseInt(h12[1], 10);
    const minute = h12[2] ? Number.parseInt(h12[2], 10) : 0;
    const mer = h12[3];
    if (mer === 'pm' && hour !== 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  return null;
}

interface ScopeMatch {
  dow: string;
  label: string;
}

/** Detect weekday / weekend / specific day-of-week scope. */
function extractScope(text: string): ScopeMatch | null {
  if (/\bweekdays?\b/.test(text)) return { dow: '1-5', label: 'weekday' };
  if (/\bweekends?\b/.test(text)) return { dow: '6,0', label: 'weekend' };

  // "every monday", "on tuesdays", "every mon"
  const dayRe = new RegExp(`\\b(?:every|on)\\s+${DAY_NAME_PATTERN}s?\\b`);
  const m = text.match(dayRe);
  const dayName = m?.[1];
  if (dayName) {
    const day = DAY_NAME_TO_DOW[dayName];
    if (day !== undefined) {
      return { dow: String(day), label: `day-of-week:${dayName}` };
    }
  }
  return null;
}

interface TimezoneExtraction {
  text: string;
  timezone: string;
  tzError?: string;
}

/**
 * Extract a trailing `in <IANA>` clause from the input. Validates the name
 * with `Intl.DateTimeFormat`. Returns the stripped text + resolved timezone.
 */
function extractTimezone(text: string, fallback: string): TimezoneExtraction {
  const match = text.match(/\bin\s+([a-z][a-z0-9_+\-/]+)\s*$/i);
  if (!match?.[1] || match.index === undefined) {
    const ok = isValidTimezone(fallback);
    return ok
      ? { text, timezone: fallback }
      : { text, timezone: fallback, tzError: `invalid fallback timezone "${fallback}"` };
  }
  const raw = match[1];
  const matchIndex = match.index;
  // Re-title-case the IANA name: user typing `asia/bangkok` should still
  // match the canonical `Asia/Bangkok`. Intl is case-sensitive on some
  // platforms, so try both.
  const normalized = toIanaCase(raw);
  if (isValidTimezone(normalized)) {
    return { text: text.slice(0, matchIndex).trimEnd(), timezone: normalized };
  }
  return {
    text,
    timezone: fallback,
    tzError: `unknown timezone "${raw}"`,
  };
}

function toIanaCase(raw: string): string {
  // `asia/bangkok` → `Asia/Bangkok`; `utc` → `UTC`.
  if (raw.toLowerCase() === 'utc') return 'UTC';
  return raw
    .split('/')
    .map((part) =>
      part
        .split('_')
        .map((seg) => {
          if (seg.length === 0) return seg;
          const first = seg.charAt(0).toUpperCase();
          return first + seg.slice(1);
        })
        .join('_'),
    )
    .join('/');
}

function isValidTimezone(tz: string): boolean {
  try {
    // DateTimeFormat throws on an unknown timeZone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// nextFireAt — evaluate a CRON string against a wall clock in a given TZ.
// ---------------------------------------------------------------------------

interface CronFields {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
}

const MINUTE_MS = 60_000;

/**
 * Compute the next epoch-ms the given CRON fires at or after `from`.
 * Evaluates the CRON in `timezone` using `Intl.DateTimeFormat`. Supports
 * the exact subset parsed by `parseCron`: `*`, `N`, `A-B`, `A,B,C`, `*​/N`.
 *
 * Throws on unparseable CRON strings — callers should only pass values
 * produced by `parseCron`.
 */
export function nextFireAt(cron: string, timezone: string, from: number): number {
  const fields = parseCronFields(cron);

  // Start searching from the next whole minute after `from`.
  let candidate = Math.ceil((from + 1) / MINUTE_MS) * MINUTE_MS;

  // Bound the search at ~366 days × 1440 min/day + a safety margin. The
  // largest legal gap in our grammar is "every monday at 9am" with 7-day
  // period; searching a full year is comfortable and prevents infinite
  // loops if the CRON is unsatisfiable.
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const parts = getZonedParts(candidate, timezone);
    if (fieldMatches(parts, fields)) return candidate;
    candidate += MINUTE_MS;
  }
  throw new Error(`nextFireAt: no match within 1 year for cron "${cron}" in ${timezone}`);
}

function fieldMatches(parts: ZonedParts, f: CronFields): boolean {
  return (
    f.minutes.has(parts.minute) &&
    f.hours.has(parts.hour) &&
    f.daysOfMonth.has(parts.day) &&
    f.months.has(parts.month) &&
    f.daysOfWeek.has(parts.weekday)
  );
}

export function parseCronFields(cron: string): CronFields {
  const tokens = cron.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(`invalid cron "${cron}": expected 5 fields, got ${tokens.length}`);
  }
  const m = tokens[0] ?? '';
  const h = tokens[1] ?? '';
  const dom = tokens[2] ?? '';
  const mon = tokens[3] ?? '';
  const dow = tokens[4] ?? '';
  return {
    minutes: expandField(m, 0, 59),
    hours: expandField(h, 0, 23),
    daysOfMonth: expandField(dom, 1, 31),
    months: expandField(mon, 1, 12),
    daysOfWeek: expandField(dow, 0, 6),
  };
}

function expandField(token: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of token.split(',')) {
    if (!part) continue;
    // Step: `*/N` or `A-B/N`
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let base = part;
    let step = 1;
    if (stepMatch?.[1] && stepMatch[2]) {
      base = stepMatch[1];
      step = Number.parseInt(stepMatch[2], 10);
      if (step < 1) throw new Error(`invalid step in cron field "${token}"`);
    }
    let start: number;
    let end: number;
    if (base === '*') {
      start = lo;
      end = hi;
    } else if (/^\d+-\d+$/.test(base)) {
      const parts = base.split('-');
      const aStr = parts[0] ?? '';
      const bStr = parts[1] ?? '';
      start = Number.parseInt(aStr, 10);
      end = Number.parseInt(bStr, 10);
    } else if (/^\d+$/.test(base)) {
      start = end = Number.parseInt(base, 10);
    } else {
      throw new Error(`invalid cron token "${part}" in field "${token}"`);
    }
    if (start < lo || end > hi || start > end) {
      throw new Error(`cron token "${part}" out of range [${lo}..${hi}]`);
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0-6, 0 = Sunday (cron convention)
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getZonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = zonedFormatterCache.get(timezone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  zonedFormatterCache.set(timezone, fmt);
  return fmt;
}

const WEEKDAY_SHORT_TO_CRON: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getZonedParts(epochMs: number, timezone: string): ZonedParts {
  const fmt = getZonedFormatter(timezone);
  const parts = fmt.formatToParts(new Date(epochMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number.parseInt(part.value, 10);
        break;
      case 'month':
        month = Number.parseInt(part.value, 10);
        break;
      case 'day':
        day = Number.parseInt(part.value, 10);
        break;
      case 'hour':
        // Intl emits `24` at midnight on some platforms.
        hour = Number.parseInt(part.value, 10) % 24;
        break;
      case 'minute':
        minute = Number.parseInt(part.value, 10);
        break;
      case 'weekday':
        weekday = WEEKDAY_SHORT_TO_CRON[part.value] ?? 0;
        break;
    }
  }
  return { year, month, day, hour, minute, weekday };
}
