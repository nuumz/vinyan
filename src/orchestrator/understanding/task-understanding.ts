/**
 * Task Understanding — unified intermediate representation for task semantics.
 *
 * Computed once at ingestion (rule-based, A3-safe), enriched after perception.
 * Replaces fragmented goal parsing across self-model, task-fingerprint, and prompt assembly.
 *
 * Gap 9A: single source of truth for task semantics.
 * Gap 5B: unified extractActionVerb (from task-fingerprint.ts).
 * Gap 1C: consistent verb extraction across all components.
 * Gap 3A: symbol extraction from goal.
 * Gap 2B: goal-based action category (mutation vs analysis vs investigation).
 */
import { createHash } from 'node:crypto';
import type { TraceStore } from '../../db/trace-store.ts';
import type { WorldGraph } from '../../world-graph/world-graph.ts';
import { EntityResolver } from './entity-resolver.ts';
import { profileHistory } from './historical-profiler.ts';
import { computeTaskSignature } from '../prediction/self-model.ts';
import { extractActionVerb } from '../task-fingerprint.ts';
import type { ActionCategory, SemanticTaskUnderstanding, TaskDomain, TaskInput, TaskIntent, TaskType, TaskUnderstanding, ToolRequirement } from '../types.ts';
import type { UnderstandingEngine } from './understanding-engine.ts';

/** Keywords that indicate software engineering context (Set-based O(1) lookup). */
const CODE_KEYWORD_SET = new Set([
  'file', 'code', 'src', 'function', 'class', 'module', 'import', 'export', 'test', 'api',
  'endpoint', 'bug', 'error', 'refactor', 'deploy', 'build', 'compile', 'lint', 'type',
  'interface', 'schema', 'database', 'query', 'migration', 'docker', 'ci', 'cd', 'pipeline',
  'git', 'branch', 'merge', 'commit', 'config', 'env', 'package', 'dependency', 'library',
  'framework', 'server', 'client', 'route', 'middleware', 'controller', 'service', 'model',
  'component', 'hook', 'state', 'prop', 'render', 'template', 'style', 'css', 'html', 'jsx',
  'tsx', 'vue', 'svelte', 'astro', 'sql', 'orm', 'redis', 'kafka', 'queue', 'socket', 'auth',
  'token', 'jwt', 'oauth', 'session', 'cookie', 'cors', 'ssl', 'tls', 'cert', 'log', 'metric',
  'trace', 'debug', 'monitor', 'alert', 'cron', 'schedule', 'script', 'cli', 'command', 'tool',
  'plugin', 'extension', 'sdk', 'worker', 'thread', 'process', 'cache', 'index', 'regex',
  'parse', 'serialize', 'encode', 'decode', 'hash', 'encrypt', 'algorithm', 'tree', 'graph',
  'stack', 'heap', 'sort', 'search', 'complexity', 'runtime', 'memory', 'cpu', 'performance',
  'optimize', 'benchmark', 'latency', 'throughput',
]);
/** Multi-word code patterns that need regex (compound terms). */
const CODE_COMPOUND_RE = /\b(data.?structure|linked.?list|profil)\b/i;

function containsCodeKeyword(text: string): boolean {
  const words = text.toLowerCase().split(/[\s,.:;!?()[\]{}"'`]+/);
  if (words.some(w => CODE_KEYWORD_SET.has(w))) return true;
  return CODE_COMPOUND_RE.test(text);
}

/** Keywords that strongly indicate non-software-engineering context (Set-based). */
const NON_CODE_KEYWORD_SET = new Set([
  'screenshot', 'photo', 'picture', 'camera', 'weather', 'recipe', 'cook', 'translate',
  'song', 'music', 'play', 'movie', 'game', 'joke', 'poem', 'story', 'draw', 'paint',
  'calendar', 'appointment', 'reminder', 'email', 'message', 'chat', 'call', 'phone',
  'drive', 'map', 'direction', 'flight', 'hotel', 'book', 'shop', 'buy', 'order',
  'deliver', 'price', 'stock', 'crypto', 'bitcoin', 'exercise', 'workout', 'diet',
  'nutrition', 'health', 'doctor', 'medicine', 'symptom',
]);

function containsNonCodeKeyword(text: string): boolean {
  const words = text.toLowerCase().split(/[\s,.:;!?()[\]{}"'`]+/);
  return words.some(w => NON_CODE_KEYWORD_SET.has(w));
}

/** Greeting patterns across common languages. */
const GREETING_PATTERN = /^\s*(สวัสดี|หวัดดี|hello|hi|hey|good\s+(morning|afternoon|evening)|howdy|こんにちは|你好|bonjour|hola|\u0421\u0430\u043b\u0430\u043c|\u0645\u0631\u062d\u0628\u0627)\s*[!?.,\u0e46]*\s*$/i;

/**
 * Classify task domain — determines capability scope and tool access.
 * Rule-based (A3-safe): same input always produces same domain classification.
 *
 * Classification priority:
 * 1. Greetings → conversational (lightweight LLM response, no tools)
 * 2. Non-code keywords without code context → general-reasoning (no tools)
 * 3. Has target files → code-mutation or code-reasoning
 * 4. Goal contains code keywords → code-reasoning or code-mutation
 * 5. Short goal without code context → general-reasoning
 * 6. Default → general-reasoning
 */
export function classifyTaskDomain(
  understanding: TaskUnderstanding,
  taskType: TaskType,
  targetFiles?: string[],
): TaskDomain {
  const goal = understanding.rawGoal;
  const hasTargetFiles = (targetFiles?.length ?? 0) > 0;

  // 1. Greetings → conversational (lightweight natural response, no tools)
  if (GREETING_PATTERN.test(goal)) {
    return 'conversational';
  }

  // 2. Non-code keywords without any code keywords → general-reasoning
  // Vinyan is a general-purpose orchestrator — LLM responds from knowledge or explains limitations naturally.
  if (containsNonCodeKeyword(goal) && !containsCodeKeyword(goal)) {
    return 'general-reasoning';
  }

  // 3. Has explicit target files → code task (mutation or reasoning based on category)
  if (hasTargetFiles) {
    return understanding.expectsMutation ? 'code-mutation' : 'code-reasoning';
  }

  // 4. Goal references code concepts
  if (containsCodeKeyword(goal)) {
    // Code task with mutation verbs → code-mutation
    if (understanding.expectsMutation && taskType === 'code') {
      return 'code-mutation';
    }
    // Code-related analysis or reasoning task → code-reasoning
    return 'code-reasoning';
  }

  // 5. Short generic goal without any code signals → general-reasoning
  // Let the LLM handle ambiguous requests naturally.
  if (goal.length < 40 && !understanding.targetSymbol) {
    return 'general-reasoning';
  }

  // 6. Default: general reasoning (might be about code concepts without keywords)
  return 'general-reasoning';
}

// ── Intent Classification (Frame-First) ──────────────────────────────────
//
// Frame-first design: detect sentence structure (question vs command) before
// matching individual verbs. This prevents priority inversion where ช่วย/explain
// triggers execute even in questions like "ช่วยอธิบาย" or "explain how X works".
//
// Inquiry frames are checked BEFORE command frames because:
// - "ทำไมมันถึง error" contains ทำ (command verb) but is clearly a question
// - "explain the deploy process" contains deploy (command verb) but asks for info
// - False positive inquiry (answer a question) is cheap — user re-asks as command
// - False positive execute (act on a question) is dangerous — may cause mutations

/** Thai question markers at sentence end — strongest Thai inquiry signal. */
const THAI_QUESTION_END = /(?:อะไร|ยังไง|อย่างไร|เท่าไหร่|กี่|ไหม|มั้ย|หรือเปล่า|รึเปล่า|ใช่ไหม|ใช่มั้ย|หรือยัง|ได้ไหม|ดีไหม|คืออะไร|หมายความว่า)\s*[?]*\s*$/;

/** Thai inquiry governing verbs — explanation/information requests. */
const THAI_INQUIRY_GOVERNING = /(?:^\s*(?:อะไร|ทำไม))|(?:อธิบาย|ช่วยอธิบาย|ช่วยบอก|ช่วยเล่า|ช่วยตอบ|ช่วยแนะนำ|เล่าให้ฟัง)/;

/** English inquiry frame — question words at start + explanation request phrases. */
const ENGLISH_INQUIRY_FRAME = /(?:^\s*(?:how|what|why|where|when|who|which)\b)|(?:^\s*(?:is|are|does|do|can|could|should|would)\s+(?:it|this|that|there|I|we|you|the)\b)|(?:\b(?:explain|describe|tell me|show me how|walk me through|help me understand|want to (?:know|understand)|what does\b.+\bmean)\b)/i;

// ── Thai Command Detection (compound-aware) ─────────────────────────────
//
// Thai has NO word boundaries (\b doesn't work, \s between words doesn't exist).
// Regex with lookaheads/lookbehinds is a whack-a-mole game that keeps breaking.
//
// Instead, we use compound masking:
// 1. Match compositional patterns first (ช่วย+verb, อยากให้...verb)
// 2. Mask known non-command compounds (เปิดเผย, ทำไม, etc.) so they can't
//    trigger false positives on the verb substring
// 3. Check for bare command verbs via simple string.includes()
//
// Adding a new false-positive? Just add the compound string to
// THAI_NON_COMMAND_COMPOUNDS — no regex surgery needed.

/** Thai verbs that signal command intent when standalone. */
const THAI_COMMAND_VERBS = [
  'รัน', 'ติดตั้ง', 'แก้', 'สร้าง', 'ลบ', 'เปิด', 'ปิด',
  'ส่ง', 'ย้าย', 'ทำ', 'ถอน', 'อัพเดท', 'อัปเดต', 'คัดลอก',
];

/**
 * Compound words that contain a command verb as substring but are NOT commands.
 * Sorted longest-first to prevent partial masking (e.g. "ทำอะไร" before "ทำ").
 */
const THAI_NON_COMMAND_COMPOUNDS = [
  // เปิด → non-action meanings
  'เปิดเผย', 'เปิดใจ', 'เปิดโอกาส', 'เปิดตัว',
  // ปิด → non-action meanings
  'ปิดบัง', 'ปิดกั้น',
  // ทำ → question words / non-imperative
  'ทำไม', 'ทำอะไร', 'ทำยังไง', 'ทำได้', 'ทำให้', 'ทำงาน', 'ทำการ',
  // แก้ → non-action meanings
  'แก้ตัว', 'แก้แค้น',
  // ส่ง → non-action meanings
  'ส่งผล', 'ส่งเสริม',
  // สร้าง → non-action meanings
  'สร้างสรรค์', 'สร้างเสริม',
].sort((a, b) => b.length - a.length); // longest first

/** ช่วย + action verb compounds — always command. */
const THAI_HELP_COMMAND_RE = /ช่วย(?:รัน|ลบ|สร้าง|แก้|ติดตั้ง|ย้าย|ถอน|ส่ง|เปิด|ปิด|อัพเดท|อัปเดต|deploy|เปิดไฟล์|สร้างไฟล์|ลบไฟล์|ย้ายไฟล์|คัดลอก)/;

/** อยากให้ ... verb — Thai request pattern, always command. */
const THAI_WANT_COMMAND_RE = /อยากให้.*?(?:รัน|สร้าง|ลบ|เปิด|ปิด|แก้|ติดตั้ง|ย้าย|ส่ง|ทำ)/;

/**
 * Detect Thai command intent using compound-aware masking.
 * A3-safe: deterministic, same input → same result.
 */
function containsThaiCommand(text: string): boolean {
  // Pattern 1: ช่วย+verb = always command
  if (THAI_HELP_COMMAND_RE.test(text)) return true;

  // Pattern 2: อยากให้...verb = always command
  if (THAI_WANT_COMMAND_RE.test(text)) return true;

  // Pattern 3: Standalone verb detection via compound masking
  // Mask non-command compounds so their verb substrings don't trigger false positives
  let masked = text;
  for (const compound of THAI_NON_COMMAND_COMPOUNDS) {
    masked = masked.replaceAll(compound, '\u2588'.repeat(compound.length));
  }

  // Check if any bare command verb remains in the masked text
  for (const verb of THAI_COMMAND_VERBS) {
    if (masked.includes(verb)) return true;
  }

  return false;
}

/** English command verbs — Set-based O(1) lookup per word. */
const ENGLISH_COMMAND_VERBS = new Set([
  'fix', 'create', 'delete', 'remove', 'update', 'install', 'deploy', 'run', 'execute',
  'build', 'start', 'stop', 'restart', 'write', 'refactor', 'review', 'analyze', 'debug',
  'test', 'migrate', 'configure', 'setup', 'clean', 'format', 'generate', 'publish',
  'release', 'push', 'pull', 'fetch', 'merge', 'rebase', 'checkout', 'rename', 'move',
  'copy', 'show', 'list', 'add', 'implement', 'change', 'modify', 'set', 'enable',
  'disable', 'upgrade', 'downgrade', 'init', 'reset', 'clear', 'scan', 'validate',
  'verify', 'inspect', 'open', 'close', 'connect', 'disconnect', 'send', 'capture',
  'convert', 'transform', 'download', 'upload', 'launch', 'paste', 'split', 'compress',
  'extract', 'backup', 'restore', 'schedule', 'trigger', 'sync', 'export', 'import',
  'patch', 'make',
]);

function containsEnglishCommand(text: string): boolean {
  const words = text.toLowerCase().split(/[\s,.:;!?()[\]{}"'`]+/);
  return words.some(w => ENGLISH_COMMAND_VERBS.has(w));
}

/** Meta-questions about the system itself. */
const META_PATTERN = /(?:คุณคือ|คุณทำอะไร|ทำอะไรได้|คุณเป็น)|(who are you|what can you|what are you|your capabilities|your name)/i;

/**
 * Classify task intent — what does the user want the orchestrator to DO?
 * Rule-based (A3-safe): same input always produces same intent.
 *
 * Frame-first design: detect sentence-level structure (question frame vs
 * command frame) before matching individual verbs. This prevents verbs like
 * ช่วย/explain/deploy from triggering execute when the sentence is clearly
 * a question (e.g. "ช่วยอธิบาย X คืออะไร", "explain how deploy works").
 *
 * Priority:
 * 1. Conversational domain → converse
 * 2. Meta questions about system → inquire
 * 3. Inquiry frame (question markers, explanation requests) → inquire
 * 4. Command frame (action verbs, imperative mood) → execute
 * 5. Code mutation tasks → execute
 * 6. Default → inquire (safer — doesn't promise action)
 */
export function classifyTaskIntent(
  understanding: TaskUnderstanding,
  taskDomain: TaskDomain,
): TaskIntent {
  const goal = understanding.rawGoal;

  // 1. Conversational domain → converse
  if (taskDomain === 'conversational') return 'converse';

  // 2. Meta questions about system capabilities
  if (META_PATTERN.test(goal)) return 'inquire';

  // 3. Inquiry frame — BEFORE commands (fixes priority inversion)
  if (THAI_QUESTION_END.test(goal) || THAI_INQUIRY_GOVERNING.test(goal) || ENGLISH_INQUIRY_FRAME.test(goal)) {
    return 'inquire';
  }

  // 4. Command frame — action verbs in imperative mood
  if (containsThaiCommand(goal) || containsEnglishCommand(goal)) return 'execute';

  // 5. Code mutation tasks are always execute intent
  if (taskDomain === 'code-mutation') return 'execute';

  // 6. Default: inquire (don't promise action without evidence)
  return 'inquire';
}

// ── Tool requirement patterns ──────────────────────────────────────

/** CLI tools / system commands that require shell_exec or similar tool to execute.
 * Removed ambiguous standalone words: go, node, make, convert — too common in natural language.
 * These are still caught when combined with CLI-specific arguments in context. */
const TOOL_COMMAND_PATTERN = /\b(git|npm|bun|yarn|pnpm|docker|brew|curl|wget|pip|apt|cargo|python|ssh|scp|rsync|kubectl|terraform|aws|gcloud|az|mv|cp|rm|mkdir|chmod|chown|tar|zip|unzip|cat|ls|find|grep|sed|awk|heroku|vercel|netlify|ffmpeg|imagemagick|pandoc)\b/i;

/** Thai action verbs implying system-level execution (not just information).
 * Note: 'deploy' matches substrings (e.g. 'redeploy') — acceptable because redeploying also needs tools.
 * Note: ลง uses boundary guard to prevent matching ลงทะเบียน, ลงทุน, etc. */
const THAI_TOOL_ACTION_PATTERN = /(?:รัน|ติดตั้ง|ลง(?:\s|$)|ถอน|อัพเดท|อัปเดต|deploy|เปิดไฟล์|เปิดแอพ|เปิดโปรแกรม|เปิดเว็บ|สร้างไฟล์|ลบไฟล์|ย้ายไฟล์|คัดลอก)/;

/**
 * Assess whether a task requires tool execution to achieve its goal.
 * Rule-based (A3-safe): same input always produces same result.
 *
 * Priority order:
 * 1. Conversational → none (greetings don't need tools)
 * 2. CLI command mention → tool-needed REGARDLESS of intent/domain
 *    "git commit ว่าอะไร" needs `git log` even though it's phrased as a question.
 *    False positive (L2 for "git คืออะไร?") is cheap — model answers from knowledge.
 *    False negative (hallucinate tool calls at L1) is expensive and wrong.
 *    Design principle: Capability > token cost.
 * 3. Execute intent + Thai action verbs → tool-needed
 * 4. Otherwise → none
 */
export function assessToolRequirement(
  understanding: TaskUnderstanding,
  taskDomain: TaskDomain,
  taskIntent: TaskIntent,
): ToolRequirement {
  // Conversational tasks never need tools
  if (taskDomain === 'conversational') return 'none';

  // CLI --tool flag forces tool access
  if (understanding.constraints.includes('TOOLS:enabled')) return 'tool-needed';

  const goal = understanding.rawGoal;

  // CLI command/tool mention → always needs tool access.
  // This must come BEFORE intent/domain gates because questions about runtime
  // state ("git last commit ว่าอะไร") need tool execution to answer.
  if (TOOL_COMMAND_PATTERN.test(goal)) return 'tool-needed';

  // Non-execute intents without CLI commands don't need tools
  if (taskIntent !== 'execute') return 'none';

  // Thai action verbs implying system-level execution
  if (THAI_TOOL_ACTION_PATTERN.test(goal)) return 'tool-needed';

  return 'none';
}

/** Verbs that indicate file mutations (code generation). */
const MUTATION_VERBS = new Set([
  'fix',
  'add',
  'remove',
  'update',
  'refactor',
  'rename',
  'move',
  'extract',
  'inline',
  'optimize',
  'migrate',
  'convert',
  'implement',
  'delete',
  'create',
]);

/** Verbs that indicate read-only analysis. */
const ANALYSIS_VERBS = new Set(['analyze', 'explain', 'describe', 'review', 'audit', 'inspect', 'summarize']);

/** Verbs that indicate investigation/debugging. */
const INVESTIGATION_VERBS = new Set(['investigate', 'debug', 'trace', 'find', 'diagnose', 'why']);

/** Verbs that indicate design/planning. */
const DESIGN_VERBS = new Set(['design', 'plan', 'architect', 'propose', 'suggest']);

/** Classify action verb into semantic category. */
function classifyActionCategory(verb: string, goal: string): ActionCategory {
  if (MUTATION_VERBS.has(verb)) return 'mutation';
  if (ANALYSIS_VERBS.has(verb)) return 'analysis';
  if (INVESTIGATION_VERBS.has(verb)) return 'investigation';
  if (DESIGN_VERBS.has(verb)) return 'design';

  // Fallback: check if the goal contains mutation-indicating words
  const lower = goal.toLowerCase();
  if (verb === 'test' || verb === 'write') {
    // "test X" could be "write tests for X" (mutation) or "test if X works" (analysis)
    // If goal mentions "write" or "add" near "test", it's mutation
    if (/write\s+tests?\b|add\s+tests?\b|create\s+tests?\b/.test(lower)) return 'mutation';
    return 'qa';
  }

  // Unknown verb — check for mutation signals in goal
  if (/\b(change|modify|edit|rewrite|replace|patch)\b/.test(lower)) return 'mutation';
  if (/\b(what|how|why|explain|describe|show)\b/.test(lower)) return 'analysis';

  // Short goals without code-related keywords are likely conversational/analysis
  if (lower.length < 30 && !/\b(file|code|src|function|class|module|import|test)\b/i.test(lower)) {
    return 'analysis';
  }

  return 'mutation'; // Default: assume mutation (safer — triggers full verification)
}

/**
 * Extract symbol references from goal text.
 * Matches backtick-wrapped identifiers and PascalCase.DotNotation patterns.
 */
function extractTargetSymbol(goal: string): string | undefined {
  // Backtick-wrapped: `AuthService.validate` or `validateToken`
  const backtickMatch = goal.match(/`([A-Za-z_$][\w$]*(?:\.\w+)*)`/);
  if (backtickMatch) return backtickMatch[1];

  // PascalCase.method pattern (not inside quotes): AuthService.validate
  const dotNotation = goal.match(/\b([A-Z][\w]*\.[\w]+(?:\.[\w]+)*)\b/);
  if (dotNotation) return dotNotation[1];

  return undefined;
}

/**
 * Build TaskUnderstanding from a TaskInput.
 * Rule-based (A3-safe) — no LLM in the path.
 * Call once at task ingestion; enrich with frameworkContext after perception.
 */
export function buildTaskUnderstanding(input: TaskInput): TaskUnderstanding {
  const actionVerb = extractActionVerb(input.goal);
  let actionCategory = classifyActionCategory(actionVerb, input.goal);

  // Reasoning tasks with no target files override mutation default → analysis
  // Prevents non-English greetings/questions from being classified as code mutations
  if (actionCategory === 'mutation' && input.taskType === 'reasoning' && !input.targetFiles?.length) {
    actionCategory = 'analysis';
  }

  const targetSymbol = extractTargetSymbol(input.goal);
  const expectsMutation = actionCategory === 'mutation' || actionCategory === 'qa';

  return {
    rawGoal: input.goal,
    actionVerb,
    actionCategory,
    targetSymbol,
    frameworkContext: [], // Populated after perception (detectFrameworkMarkers)
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    expectsMutation,
  };
}

/**
 * Enrich TaskUnderstanding with perception-derived data.
 * Called after perception assembly to add framework markers and fingerprint.
 */
export function enrichWithPerception(understanding: TaskUnderstanding, frameworkMarkers: string[]): TaskUnderstanding {
  return {
    ...understanding,
    frameworkContext: frameworkMarkers,
  };
}

/** Dependencies for Layer 0+1 understanding enrichment. */
export interface EnrichUnderstandingDeps {
  workspace: string;
  worldGraph?: WorldGraph;
  traceStore?: TraceStore;
}

/**
 * Layer 0+1: deterministic, pre-routing. Always runs. Cost: 0 tokens.
 *
 * Composes Layer 0 (rule-based extraction) + Layer 1 (entity resolution + historical profiling)
 * into a SemanticTaskUnderstanding. This is the single entry point for the core loop.
 */
export function enrichUnderstanding(
  input: TaskInput,
  deps: EnrichUnderstandingDeps,
  opts?: { forceRefresh?: boolean },
): SemanticTaskUnderstanding {
  // Layer 0: existing rule-based extraction
  const base = buildTaskUnderstanding(input);

  // Layer 0: domain classification (A2 boundary, tool scoping)
  const taskDomain = classifyTaskDomain(base, input.taskType, input.targetFiles);

  // Layer 0: intent classification (response framing — concept §1: orchestrator, not Q&A)
  const taskIntent = classifyTaskIntent(base, taskDomain);

  // Layer 0: tool requirement (capability routing floor)
  const toolRequirement = assessToolRequirement(base, taskDomain, taskIntent);

  // Layer 1: entity resolution (NL → code paths)
  const resolver = new EntityResolver(deps.workspace, deps.worldGraph);
  const resolvedEntities = resolver.resolve(input, base, opts);

  // Layer 1: historical profiling (recurring detection, failure oracles)
  const historicalProfile = deps.traceStore ? profileHistory(input, deps.traceStore) : undefined;

  // P8: content-addressed fingerprint for Layer 0+1
  const resolvedPaths = resolvedEntities.flatMap((e) => e.resolvedPaths).sort();
  const signature = computeTaskSignature(input);
  const understandingFingerprint = createHash('sha256')
    .update(input.goal + JSON.stringify(resolvedPaths) + signature)
    .digest('hex');

  return {
    ...base,
    taskDomain,
    taskIntent,
    toolRequirement,
    resolvedEntities,
    historicalProfile,
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint,
  };
}

// ── Layer 2: Semantic Understanding (LLM, budget-gated) ─────────────────

/** Dependencies for Layer 2 understanding enrichment. */
export interface EnrichUnderstandingL2Deps {
  understandingEngine: UnderstandingEngine;
  workspace: string;
}

/**
 * Layer 2: LLM-based semantic intent extraction. Post-routing, budget-gated.
 * Gracefully degrades to Layer 0+1 on any failure (parse, timeout, circuit open).
 */
export async function enrichUnderstandingL2(
  understanding: SemanticTaskUnderstanding,
  deps: EnrichUnderstandingL2Deps,
  budget: { remainingTokens: number; timeoutMs?: number },
): Promise<SemanticTaskUnderstanding> {
  const {
    LAYER2_MIN_BUDGET_TOKENS,
    LAYER2_TIMEOUT_MS,
    buildUnderstandingPrompt,
    parseSemanticIntent,
    verifyImplicitConstraints,
  } = await import('./understanding-engine.ts');

  // Budget gate
  if (budget.remainingTokens < LAYER2_MIN_BUDGET_TOKENS) return understanding;
  if (understanding.understandingDepth >= 2) return understanding;

  // Circuit breaker check
  if (deps.understandingEngine.shouldSkip()) return understanding;

  // Cache check
  const cached = deps.understandingEngine.getCached(understanding.understandingFingerprint);
  if (cached) return { ...understanding, semanticIntent: cached, understandingDepth: 2 };

  // Execute L2 with timeout
  const { systemPrompt, userPrompt } = buildUnderstandingPrompt(understanding);
  try {
    const response = await Promise.race([
      deps.understandingEngine.execute({ systemPrompt, userPrompt, maxTokens: 500 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('L2 timeout')), budget.timeoutMs ?? LAYER2_TIMEOUT_MS),
      ),
    ]);

    const parsed = parseSemanticIntent(response.content);
    if (!parsed) {
      deps.understandingEngine.recordResult(false);
      return understanding;
    }

    // Verify implicit constraints against codebase evidence
    const { verified, claims } = verifyImplicitConstraints(parsed.implicitConstraints, deps.workspace);
    parsed.implicitConstraints = verified;

    deps.understandingEngine.recordResult(true);
    deps.understandingEngine.setCached(understanding.understandingFingerprint, parsed);

    return {
      ...understanding,
      semanticIntent: parsed,
      understandingDepth: 2,
      verifiedClaims: [...understanding.verifiedClaims, ...claims],
    };
  } catch {
    deps.understandingEngine.recordResult(false);
    return understanding; // Graceful degradation
  }
}
