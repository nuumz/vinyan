/**
 * External Coding CLI intent classifier — deterministic NL → structured intent.
 *
 * Detects natural-language requests that ask Vinyan to delegate work to an
 * external coding CLI agent (Claude Code, GitHub Copilot, etc.) so the
 * orchestrator does NOT route them through `direct-tool` `shell_exec`.
 *
 * Without this layer, prompts like
 *
 *   "สั่งงาน claude code cli ช่วยรัน verify flow `/Users/.../s1_design_spec`"
 *
 * fall through to the shell_exec pre-classifier, get tokenized as a shell
 * command, and the metacharacter parser rejects them with
 * "Shell command contains dangerous metacharacter" — punishing the user for
 * writing a perfectly reasonable delegation request.
 *
 * Pure function: no I/O, no LLM. Same input → same verdict (A3).
 *
 * Two structural anchors are required for a positive match:
 *   1. A *provider mention* — "claude code", "github copilot", "codex", etc.
 *   2. A *delegation/usage verb* — "สั่งงาน", "ใช้", "ask", "delegate", "run X with".
 *
 * Bare provider mentions ("what is Claude Code?", "Claude Code is a CLI") are
 * NOT matched — those are conversational. A delegation verb without a
 * provider name is also NOT matched — those are generic shell intents.
 */
import type { CodingCliProviderId } from '../external-coding-cli/types.ts';

export type CodingCliRequestedMode = 'headless' | 'interactive' | 'auto';

export interface CodingCliIntentClassification {
  /** True when the goal text is a structurally unambiguous delegation request. */
  matched: boolean;
  /** Detected provider (or `'auto'` for unspecified / ambiguous between providers). */
  providerId: CodingCliProviderId | 'auto';
  /** Requested mode — falls back to `'auto'` when not specified. */
  requestedMode: CodingCliRequestedMode;
  /** The actual work to send to the CLI (provider mention stripped, paths preserved). */
  taskText: string;
  /** Working directory if the user supplied an absolute path. */
  cwd?: string;
  /** Detected target paths (any quoted or unquoted absolute/home/dot paths). */
  targetPaths: string[];
  /** Confidence — ≥ 0.85 trips the deterministic skip in intent-resolver. */
  confidence: number;
  /** Human-readable explanation of which signals fired (for traces / debugging). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Provider mentions — anchored to multi-word phrases. Single-token "claude"
// or "copilot" alone is too noisy (e.g. "Claude said hello"). Provider phrases
// MUST appear with a CLI/agent qualifier OR a delegation verb to count.
// ---------------------------------------------------------------------------

interface ProviderMatch {
  providerId: CodingCliProviderId | 'auto';
  matchedPhrase: string;
}

/**
 * Provider mention patterns. Order: specific → generic. The first match wins
 * so "claude code cli" beats "claude code" beats "claude". For ambiguous
 * generic "coding cli" / "external cli" / "ai cli" mentions we emit `'auto'`
 * and let the controller's capability matrix pick.
 */
const PROVIDER_PATTERNS: Array<{ pattern: RegExp; providerId: CodingCliProviderId | 'auto' }> = [
  // Claude Code — most specific phrasings first.
  { pattern: /\bclaude[\s_-]*code[\s_-]*cli\b/i, providerId: 'claude-code' },
  { pattern: /\bclaude[\s_-]*code\b/i, providerId: 'claude-code' },
  { pattern: /\bclaudecode\b/i, providerId: 'claude-code' },
  { pattern: /คล็อด\s*โค้ด/i, providerId: 'claude-code' },
  // GitHub Copilot.
  { pattern: /\bgithub\s+copilot\s+cli\b/i, providerId: 'github-copilot' },
  { pattern: /\bgh\s+copilot\b/i, providerId: 'github-copilot' },
  { pattern: /\bcopilot\s+cli\b/i, providerId: 'github-copilot' },
  { pattern: /\bgithub\s+copilot\b/i, providerId: 'github-copilot' },
  // Generic — operator wants any available coding CLI agent.
  { pattern: /\bexternal\s+coding\s+cli\b/i, providerId: 'auto' },
  { pattern: /\bcoding\s+cli\b/i, providerId: 'auto' },
  { pattern: /\bexternal\s+cli\b/i, providerId: 'auto' },
  // Codex (OpenAI) — limited support today; route as auto so the controller
  // surfaces unsupported-capability honestly rather than silently routing
  // to claude-code.
  { pattern: /\b(?:openai\s+)?codex\s+cli\b/i, providerId: 'auto' },
];

function detectProvider(text: string): ProviderMatch | null {
  for (const { pattern, providerId } of PROVIDER_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      return { providerId, matchedPhrase: m[0] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Delegation verbs — the user is asking Vinyan to *use* / *delegate to* the
// CLI, not asking what the CLI is or how it works. The verb must be present
// for a match to fire.
// ---------------------------------------------------------------------------

const DELEGATION_VERB_THAI =
  /(?:สั่งงาน|มอบหมาย|ส่งให้|ส่งงานให้|ส่งงาน|ใช้\s|ใช้ให้|ให้\s|ช่วย|เรียก|ผ่าน(?:ทาง)?|ร่วมกับ|ลอง(?:ใช้|ให้)|รัน|run\s+with|ทำงานกับ|ทำงานผ่าน)/i;

const DELEGATION_VERB_ENGLISH =
  /\b(?:ask|tell|delegate(?:\s+to)?|use|have|make|let|run(?:\s+(?:on|with|via|using|through))?|spawn|kick\s+off|hand\s+off|delegate\s+work\s+to|with\s+the\s+help\s+of|via|through)\b/i;

/**
 * Conversational signals — when present, suppress the match because the user
 * is asking *about* the CLI rather than asking us to *use* it. Best-effort.
 *
 * Examples:
 *   "what is claude code?"              → suppress
 *   "อะไรคือ claude code"                → suppress
 *   "explain claude code cli"           → suppress (no delegation verb anyway)
 *   "describe how claude code works"    → suppress
 */
const CONVERSATIONAL_INQUIRY_THAI =
  /(?:อะไรคือ|คืออะไร|หมายความว่า|มันคือ|มันทำงานยังไง|ใช้งานยังไง|อธิบาย|บอกฉันเกี่ยวกับ|เปรียบเทียบ|มีอะไร|รู้จัก)/i;
const CONVERSATIONAL_INQUIRY_ENGLISH =
  /\b(?:what\s+is|what's|describe|explain|tell\s+me\s+about|compare|do\s+you\s+know|how\s+does)\b/i;

// ---------------------------------------------------------------------------
// Mode hints — explicit user signals override the default `'auto'`.
// ---------------------------------------------------------------------------

function detectRequestedMode(text: string): CodingCliRequestedMode {
  const lower = text.toLowerCase();
  if (
    /\binteractive\b/.test(lower) ||
    /พูดคุย|สนทนา|คุยกับ|chat\s+with|conversation/.test(lower)
  ) {
    return 'interactive';
  }
  if (
    /\bheadless\b/.test(lower) ||
    /one[-\s]?shot|ครั้งเดียว|แบบไม่ต้องตอบโต้|non[-\s]?interactive/.test(lower)
  ) {
    return 'headless';
  }
  return 'auto';
}

// ---------------------------------------------------------------------------
// Path extraction — captures absolute paths, home-relative, and dot-relative,
// quoted or backticked. Backticked paths matter especially because they are
// what triggers the shell-policy false-positive when the prompt is mistakenly
// routed to shell_exec.
// ---------------------------------------------------------------------------

const PATH_PATTERNS: RegExp[] = [
  // Backtick-wrapped paths: `/abs/path` or `~/path`
  /`([^`]+)`/g,
  // Single/double-quoted paths
  /"([^"]+)"/g,
  /'([^']+)'/g,
  // Bare absolute / home / dot paths
  /(?<![\w/])((?:\/|~\/|\.\.?\/)[\w./~-]{2,})/g,
];

function looksLikeFilesystemPath(s: string): boolean {
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false;
  return /^[\/~.]/.test(s) || s.includes('/');
}

function extractTargetPaths(text: string): string[] {
  const found = new Set<string>();
  for (const pat of PATH_PATTERNS) {
    pat.lastIndex = 0; // reset stateful global regex between calls
    for (const m of text.matchAll(pat)) {
      const candidate = (m[1] ?? m[0]).trim();
      if (looksLikeFilesystemPath(candidate)) {
        found.add(candidate);
      }
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Task text extraction — strip the provider mention so the CLI receives a
// clean instruction, not "ask Claude Code CLI to ...".
// ---------------------------------------------------------------------------

function buildTaskText(rawGoal: string, providerPhrase: string): string {
  // Remove leading delegation verb + provider phrase pattern, e.g.
  //   "สั่งงาน claude code cli ช่วยรัน verify flow ..." → "ช่วยรัน verify flow ..."
  //   "ask claude code to run tests"                    → "run tests"
  // Best-effort — if the structural strip fails, we return the goal verbatim
  // (still fine; the CLI prompt template includes context anyway).
  let text = rawGoal;
  // Strip the provider phrase regardless of position.
  const providerRegex = new RegExp(
    `\\s*${providerPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`,
    'i',
  );
  text = text.replace(providerRegex, ' ');
  // Collapse common leading delegation verbs once the provider name is gone.
  text = text
    .replace(/^\s*(?:สั่งงาน|มอบหมายให้|ใช้\s+|ให้\s+|ช่วย\s+|เรียก\s+|ขอ\s+|ลองใช้\s+|run\s+with\s+|use\s+|ask\s+|tell\s+|have\s+|delegate(?:\s+to)?\s+|with\s+the\s+help\s+of\s+)/i, '')
    .replace(/^\s*(?:ทำ|do|to)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Some prompts read "use claude code to <task>" — strip a residual leading "to".
  text = text.replace(/^to\s+/i, '');
  return text || rawGoal;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Classify a user goal as an external-coding-cli delegation request.
 *
 * Returns a fully-populated classification regardless of match — callers
 * check `matched && confidence >= threshold` to decide whether to route.
 * The non-matched return shape stays cheap so this function can run
 * unconditionally on every goal.
 */
export function classifyExternalCodingCliIntent(
  goal: string,
): CodingCliIntentClassification {
  const trimmed = goal.trim();
  if (trimmed.length === 0) {
    return {
      matched: false,
      providerId: 'auto',
      requestedMode: 'auto',
      taskText: '',
      targetPaths: [],
      confidence: 0,
      reason: 'empty goal',
    };
  }

  const provider = detectProvider(trimmed);
  if (!provider) {
    return {
      matched: false,
      providerId: 'auto',
      requestedMode: 'auto',
      taskText: trimmed,
      targetPaths: extractTargetPaths(trimmed),
      confidence: 0,
      reason: 'no coding-cli provider mentioned',
    };
  }

  const hasDelegationVerb =
    DELEGATION_VERB_THAI.test(trimmed) || DELEGATION_VERB_ENGLISH.test(trimmed);

  // Conversational inquiry suppression only applies when there is NO
  // delegation verb. "ask claude code to compare X and Y" contains both an
  // inquiry term ("compare") AND a delegation verb ("ask") — that's an
  // action request, not a conversational inquiry. Suppression catches the
  // single-intent forms: "what is claude code?", "claude code คืออะไร",
  // "explain claude code".
  if (!hasDelegationVerb) {
    const inquiry =
      CONVERSATIONAL_INQUIRY_THAI.test(trimmed) || CONVERSATIONAL_INQUIRY_ENGLISH.test(trimmed);
    return {
      matched: false,
      providerId: provider.providerId,
      requestedMode: 'auto',
      taskText: trimmed,
      targetPaths: extractTargetPaths(trimmed),
      confidence: inquiry ? 0 : 0.4,
      reason: inquiry
        ? `provider mentioned but conversational inquiry detected ("${provider.matchedPhrase}")`
        : `provider "${provider.matchedPhrase}" mentioned but no delegation verb`,
    };
  }

  const targetPaths = extractTargetPaths(trimmed);
  const requestedMode = detectRequestedMode(trimmed);
  const taskText = buildTaskText(trimmed, provider.matchedPhrase);

  // Confidence tiers:
  //   - explicit provider phrase + delegation verb        → 0.9
  //   - explicit provider phrase + delegation verb + path → 0.92
  //   - generic 'auto' provider phrase + delegation verb  → 0.85 (just over threshold)
  let confidence = provider.providerId === 'auto' ? 0.85 : 0.9;
  if (targetPaths.length > 0) confidence = Math.min(confidence + 0.02, 0.95);

  // Pick the first path that looks like a directory (no file extension) as
  // a candidate cwd — Vinyan's controller still validates this against the
  // allowed workspace; this is a *hint*, not a security decision.
  const cwd = targetPaths.find((p) => !/\.[a-z0-9]{1,8}$/i.test(p));

  return {
    matched: true,
    providerId: provider.providerId,
    requestedMode,
    taskText,
    cwd,
    targetPaths,
    confidence,
    reason: `provider="${provider.matchedPhrase}" + delegation verb${targetPaths.length > 0 ? ` + ${targetPaths.length} path hint(s)` : ''}`,
  };
}
