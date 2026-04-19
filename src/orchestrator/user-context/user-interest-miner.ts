/**
 * User-Interest Miner — live aggregation from TraceStore + SessionStore.
 *
 * Produces a `UserContextSnapshot` (frequent task types, recent keywords, domains)
 * that enriches the intent resolver's prompt so ambiguous goals get classified
 * against real user history rather than the raw message alone.
 *
 * A3 compliance: the snapshot is self-reported / heuristic — it NEVER drives
 * governance. It only enriches the LLM classifier's context.
 */

import type { SessionStore } from '../../db/session-store.ts';
import type { TraceStore } from '../../db/trace-store.ts';
import type { ExecutionTrace } from '../types.ts';
import {
  EMPTY_SNAPSHOT,
  type KeywordFrequency,
  type MineOptions,
  type TaskTypeCount,
  type UserContextSnapshot,
} from './types.ts';

const DEFAULTS = {
  lookbackDays: 30,
  maxTaskTypes: 5,
  maxKeywords: 10,
  minKeywordLen: 3,
  sessionMessageTokenBudget: 4000,
  cacheTtlMs: 60_000,
} as const;

/**
 * Small bilingual stop-word list. Deliberately minimal — we only need to
 * suppress the obvious noise. Over-filtering kills signal for short Thai tokens.
 */
const STOP_WORDS_EN = new Set([
  'the', 'and', 'for', 'you', 'that', 'this', 'with', 'have', 'not', 'but',
  'are', 'was', 'were', 'can', 'will', 'would', 'could', 'should', 'just',
  'from', 'into', 'about', 'over', 'some', 'been', 'being', 'any', 'all',
  'what', 'when', 'where', 'why', 'how', 'here', 'there', 'your', 'mine',
  'please', 'thanks', 'hello', 'hi', 'okay', 'yes', 'no', 'like', 'really',
  'then', 'than', 'very', 'also', 'still', 'only', 'even', 'want', 'need',
  'get', 'got', 'one', 'two', 'new', 'old', 'make', 'made', 'use', 'used',
  'more', 'most', 'less', 'much', 'many', 'few', 'see', 'say', 'said', 'did',
  'now', 'never', 'ever', 'too', 'own', 'same', 'each', 'both', 'out', 'off',
  'don', 'does', 'had', 'has', 'its', 'them', 'they', 'their', 'our', 'we',
  'me', 'my', 'him', 'her', 'his', 'hers', 'who', 'whom',
]);

const STOP_WORDS_TH = new Set([
  'ช่วย', 'อยาก', 'ผม', 'ฉัน', 'คุณ', 'เรา', 'นี้', 'นั้น', 'หน่อย', 'หรือ',
  'และ', 'แต่', 'กับ', 'ของ', 'ที่', 'ใน', 'ให้', 'เป็น', 'ได้', 'ไม่',
  'จะ', 'จาก', 'แล้ว', 'ด้วย', 'ซึ่ง', 'ต่อ', 'ว่า', 'นะ', 'ครับ', 'ค่ะ',
  'สัก', 'อัน', 'ถ้า', 'แค่', 'ยัง', 'ก็', 'มี', 'เอา', 'เลย', 'บ้าง',
]);

/** Extract a coarse domain label from a task_type_signature. */
function signatureToDomain(signature: string): string | null {
  const lower = signature.toLowerCase();
  if (/(fix|refactor|implement|add|remove|migrate|rename|extract|inline|optimize)/.test(lower)) {
    return 'code-mutation';
  }
  if (/(reason|inquire|analyze|investigate|research|explain|summariz)/.test(lower)) {
    return 'reasoning';
  }
  if (/(write|compose|draft|author|creative|story|novel|webtoon|article)/.test(lower)) {
    return 'creative-writing';
  }
  if (/(test|spec|assert|validate)/.test(lower)) {
    return 'testing';
  }
  return null;
}

function tokenize(text: string): string[] {
  if (!text) return [];
  // Split on whitespace and common punctuation. Works reasonably for EN and
  // keeps Thai phrases together (since Thai isn't space-delimited at the word
  // level, each "chunk" will be a multi-word Thai phrase which is fine for
  // keyword surfacing).
  return text
    .toLowerCase()
    .split(/[\s,./\\!?"'`()[\]{}<>:;|=+*&^%$#@~—–\-]+/u)
    .filter((t) => t.length > 0);
}

function isStopWord(token: string): boolean {
  if (STOP_WORDS_EN.has(token) || STOP_WORDS_TH.has(token)) return true;
  // Drop pure numbers (timestamps, line numbers).
  if (/^\d+$/.test(token)) return true;
  return false;
}

export interface UserInterestMinerDeps {
  traceStore?: TraceStore;
  sessionStore?: SessionStore;
  /** Optional clock injector for deterministic tests. */
  now?: () => number;
}

interface CacheEntry {
  snapshot: UserContextSnapshot;
  cachedAt: number;
}

export class UserInterestMiner {
  private cache = new Map<string, CacheEntry>();

  constructor(private deps: UserInterestMinerDeps) {}

  /** Compute (or return cached) snapshot. Always returns a valid snapshot, never throws. */
  mine(options: MineOptions = {}): UserContextSnapshot {
    const now = this.deps.now?.() ?? Date.now();
    const sessionKey = options.sessionId ?? '__global__';
    const cached = this.cache.get(sessionKey);
    if (cached && now - cached.cachedAt < DEFAULTS.cacheTtlMs) {
      return cached.snapshot;
    }

    try {
      const snapshot = this.compute(options, now);
      this.cache.set(sessionKey, { snapshot, cachedAt: now });
      return snapshot;
    } catch (err) {
      // Best-effort: mining failures must never block intent resolution.
      console.warn('[user-interest-miner] mining failed, returning empty snapshot:', err);
      return EMPTY_SNAPSHOT;
    }
  }

  /** Invalidate the cache for a session (call after a task completes). */
  invalidate(sessionId?: string): void {
    if (sessionId) {
      this.cache.delete(sessionId);
    } else {
      this.cache.clear();
    }
  }

  private compute(options: MineOptions, now: number): UserContextSnapshot {
    const lookbackMs = (options.lookbackDays ?? DEFAULTS.lookbackDays) * 86_400_000;
    const cutoff = now - lookbackMs;
    const maxTypes = options.maxTaskTypes ?? DEFAULTS.maxTaskTypes;
    const maxKeywords = options.maxKeywords ?? DEFAULTS.maxKeywords;
    const minLen = options.minKeywordLen ?? DEFAULTS.minKeywordLen;

    const frequentTaskTypes = this.aggregateTaskTypes(cutoff, maxTypes);
    const recentKeywords = this.extractSessionKeywords(options.sessionId, maxKeywords, minLen);
    const recentDomains = this.deriveDomains(frequentTaskTypes);
    const totalTracesInWindow = this.countTracesInWindow(cutoff);
    const lastActiveAt = this.getLastActiveAt();

    return {
      frequentTaskTypes,
      recentKeywords,
      recentDomains,
      totalTracesInWindow,
      lastActiveAt,
    };
  }

  private aggregateTaskTypes(cutoff: number, maxTypes: number): TaskTypeCount[] {
    if (!this.deps.traceStore) return [];
    const recent = this.deps.traceStore.findRecent(200);
    const withinWindow = recent.filter(
      (t) => t.timestamp >= cutoff && t.taskTypeSignature,
    );
    const counts = new Map<string, number>();
    for (const trace of withinWindow) {
      const sig = trace.taskTypeSignature as string;
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([signature, count]) => ({ signature, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, maxTypes);
  }

  private extractSessionKeywords(
    sessionId: string | undefined,
    maxKeywords: number,
    minLen: number,
  ): KeywordFrequency[] {
    if (!sessionId || !this.deps.sessionStore) return [];
    // A7: Turn-model — flatten text blocks from recent user turns.
    const turns = this.deps.sessionStore.getRecentTurns(sessionId, 200);
    const userTurns = turns.filter((t) => t.role === 'user');
    if (userTurns.length === 0) return [];

    const freq = new Map<string, number>();
    for (const turn of userTurns) {
      const text = turn.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      for (const token of tokenize(text)) {
        if (token.length < minLen) continue;
        if (isStopWord(token)) continue;
        freq.set(token, (freq.get(token) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .map(([term, frequency]) => ({ term, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, maxKeywords);
  }

  private deriveDomains(taskTypes: TaskTypeCount[]): string[] {
    const domains = new Set<string>();
    for (const { signature } of taskTypes) {
      const domain = signatureToDomain(signature);
      if (domain) domains.add(domain);
    }
    return Array.from(domains).slice(0, 3);
  }

  private countTracesInWindow(cutoff: number): number {
    if (!this.deps.traceStore) return 0;
    const recent = this.deps.traceStore.findRecent(200);
    return recent.filter((t: ExecutionTrace) => t.timestamp >= cutoff).length;
  }

  private getLastActiveAt(): number | null {
    if (!this.deps.traceStore) return null;
    const recent = this.deps.traceStore.findRecent(1);
    return recent[0]?.timestamp ?? null;
  }
}

/**
 * Render a snapshot as a prompt-ready block (≤ ~300 tokens).
 * Returns empty string when the snapshot is cold-start (no signal).
 */
export function formatUserContextForPrompt(snapshot: UserContextSnapshot): string {
  const lines: string[] = [];
  if (snapshot.frequentTaskTypes.length > 0) {
    const entries = snapshot.frequentTaskTypes
      .map((t) => `${t.signature} (${t.count})`)
      .join(', ');
    lines.push(`- Frequent task types: ${entries}`);
  }
  if (snapshot.recentDomains.length > 0) {
    lines.push(`- Recent domains: ${snapshot.recentDomains.join(', ')}`);
  }
  if (snapshot.recentKeywords.length > 0) {
    const entries = snapshot.recentKeywords
      .map((k) => k.term)
      .slice(0, 10)
      .join(', ');
    lines.push(`- Recent keywords: ${entries}`);
  }
  if (lines.length === 0) return '';
  return `\nUser context (learned from past activity):\n${lines.join('\n')}`;
}
