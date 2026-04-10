/**
 * Prompt Section Registry — composable prompt architecture.
 *
 * Each section declares its target (system/user), cache tier, priority,
 * and a render function. The registry assembles prompts by sorting sections
 * by priority and concatenating non-null renders.
 *
 * Source of truth: docs/design/memory-prompt-architecture-system-design.md
 */

import { sanitizeForPrompt } from '../../guardrails/index.ts';
import type {
  CacheControl,
  ConversationEntry,
  PerceptualHierarchy,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskDomain,
  TaskUnderstanding,
  WorkingMemoryState,
} from '../types.ts';
import { READONLY_TOOLS } from '../types.ts';
import { BUILT_IN_TOOLS } from '../tools/built-in-tools.ts';
import type { InstructionMemory } from './instruction-loader.ts';

/** Sanitize a string for safe prompt inclusion. */
function clean(s: string): string {
  return sanitizeForPrompt(s).cleaned;
}

/** Check if the task domain requires code-centric prompt context. */
function isCodeDomain(domain?: TaskDomain): boolean {
  return domain === 'code-mutation' || domain === 'code-reasoning';
}

/** G1: Map tier_reliability score to human-readable label for prompt rendering. */
function tierLabel(tierReliability?: number): string {
  if (tierReliability == null) return 'unknown-tier';
  if (tierReliability >= 0.95) return 'deterministic';
  if (tierReliability >= 0.7) return 'heuristic';
  return 'probabilistic';
}

export interface SectionContext {
  goal: string;
  perception: PerceptualHierarchy;
  memory: WorkingMemoryState;
  plan?: TaskDAG;
  instructions?: InstructionMemory | null;
  /** Gap 9A: Unified task understanding — carries constraints, criteria, action category.
   *  STU Phase B: widened to SemanticTaskUnderstanding for Layer 1+2 fields. */
  understanding?: SemanticTaskUnderstanding | TaskUnderstanding;
  /** R2 (§5): Routing level — used to gate tool descriptions out of L0-L1 prompts. */
  routingLevel?: number;
  /** Conversation history from prior turns in the same session. */
  conversationHistory?: ConversationEntry[];
}

export interface PromptSection {
  /** Unique section identifier (e.g. 'task', 'perception', 'constraints'). */
  id: string;
  /** Which prompt this section belongs to. */
  target: 'system' | 'user';
  /** Cache tier hint for the section content. */
  cache: CacheControl['type'];
  /** Lower priority = earlier in prompt (10, 20, 30...). */
  priority: number;
  /** Render the section. Return null to skip. */
  render: (ctx: SectionContext) => string | null;
}

export class PromptSectionRegistry {
  private sections: PromptSection[] = [];

  register(section: PromptSection): void {
    this.sections.push(section);
  }

  /** Render all sections for a given target, sorted by priority. */
  renderTarget(target: 'system' | 'user', ctx: SectionContext): string {
    return this.sections
      .filter((s) => s.target === target)
      .sort((a, b) => a.priority - b.priority)
      .map((s) => s.render(ctx))
      .filter((s): s is string => s != null)
      .join('\n\n');
  }

  /** Get all registered section IDs. */
  getSectionIds(): string[] {
    return this.sections.map((s) => s.id);
  }
}

// ── Oracle manifest (shared constant) ───────────────────────────────

const ORACLE_MANIFEST = [
  'ast: Validates symbol existence, function signatures, import statements',
  'type: Checks TypeScript type correctness (tsc --noEmit)',
  'dep: Analyzes import graph, blast radius, dependency safety',
  'lint: Checks code style and quality rules (ESLint/Biome)',
  'test: Runs test suite, verifies all tests pass',
];

function buildOracleManifest(): string {
  return [
    '[ORACLE VERIFICATION CAPABILITIES]',
    'Each subtask you propose should be verifiable by at least one oracle:',
    ...ORACLE_MANIFEST.map((line) => `  - ${line}`),
    '',
    'When decomposing tasks, assign appropriate oracles to each node.',
    'For each node, you may specify a verificationHint with:',
    '  - oracles: which oracles to run (subset of above)',
    '  - skipTestWhen: "import-only" | "type-change-only" | "config-change"',
  ].join('\n');
}

// ── Default code-task sections ──────────────────────────────────────

/** Create the default registry with all 12 code-task sections. */
export function createDefaultRegistry(): PromptSectionRegistry {
  const registry = new PromptSectionRegistry();

  // ── System prompt sections (static, cached) ──

  registry.register({
    id: 'role',
    target: 'system',
    cache: 'static',
    priority: 10,
    render: () =>
      `[ROLE]
You are a coding worker in Vinyan, an autonomous orchestrator powered by Epistemic Orchestration.
You generate code proposals that will be verified by external oracles.
Do NOT self-evaluate your output — external verification determines correctness.`,
  });

  registry.register({
    id: 'output-format',
    target: 'system',
    cache: 'static',
    priority: 20,
    render: () =>
      `[OUTPUT FORMAT]
Respond with a JSON object matching this structure:
{
  "proposedMutations": [{ "file": "path", "content": "full file content", "explanation": "why" }],
  "proposedToolCalls": [{ "id": "tc-1", "tool": "tool_name", "parameters": {} }],
  "uncertainties": ["areas of uncertainty"]
}`,
  });

  registry.register({
    id: 'behavioral-rules',
    target: 'system',
    cache: 'ephemeral',
    priority: 30,
    render: (ctx) => {
      const rules = [
        '- If uncertain about a file\'s content, say so in "uncertainties" — do NOT guess.',
        '- Never fabricate import paths, function signatures, or type definitions.',
        '- When multiple approaches exist, list them in "uncertainties" with trade-offs.',
        "- Prefer minimal changes — do not refactor code that wasn't mentioned in the task.",
        '- If the task is ambiguous, propose the safest interpretation and flag alternatives.',
      ];
      // HMS: when prior hallucinations detected, add pointed guidance
      const hasHallucinationFailures = ctx.memory.failedApproaches.some((fa) =>
        fa.classifiedFailures?.some((cf) => cf.category.startsWith('hallucination_')),
      );
      if (hasHallucinationFailures) {
        rules.push(
          '- PRIOR HALLUCINATIONS DETECTED: Only reference files listed in [PERCEPTION]. Do NOT invent paths.',
        );
        rules.push('- Verify every import path against the dependency cone before proposing.');
      }
      return `[BEHAVIORAL RULES]\n${rules.join('\n')}`;
    },
  });

  registry.register({
    id: 'tools',
    target: 'system',
    cache: 'static',
    priority: 40,
    render: (ctx) => {
      // R2 (§5): L0-L1 must NOT receive tool descriptions — prevents hallucinated tool calls.
      if (ctx.routingLevel != null && ctx.routingLevel < 2) return null;

      const allTools = [...ctx.perception.runtime.availableTools].sort();
      if (!allTools.length) return null;

      // Classify tools by kind using BUILT_IN_TOOLS registry
      const executable: string[] = [];
      const control: string[] = [];
      for (const name of allTools) {
        const tool = BUILT_IN_TOOLS.get(name);
        const kind = tool?.descriptor().toolKind ?? 'executable';
        if (kind === 'control') control.push(name);
        else executable.push(name);
      }

      const lines = ['[AVAILABLE TOOLS]'];
      if (executable.length) lines.push(`Executable: ${executable.join(', ')}`);
      if (control.length) lines.push(`Control (orchestrator signals — do not execute, only propose): ${control.join(', ')}`);
      lines.push('');
      lines.push(`Runtime: ${process.platform} (${process.arch})`);
      lines.push('Do NOT execute tool calls yourself — propose them and the Orchestrator will execute.');
      return lines.join('\n');
    },
  });

  registry.register({
    id: 'oracle-manifest',
    target: 'system',
    cache: 'static',
    priority: 50,
    render: () => buildOracleManifest(),
  });

  // ── User prompt sections (mixed cache tiers) ──

  registry.register({
    id: 'instructions',
    target: 'user',
    cache: 'session',
    priority: 10,
    render: (ctx) => (ctx.instructions ? `[PROJECT INSTRUCTIONS]\n${clean(ctx.instructions.content)}` : null),
  });

  registry.register({
    id: 'task',
    target: 'user',
    cache: 'ephemeral',
    priority: 20,
    render: (ctx) => {
      const lines = ['[TASK]'];
      // Gap 4B: Prepend task fingerprint metadata for LLM orientation
      if (ctx.understanding) {
        const u = ctx.understanding;
        const meta: string[] = [`Action: ${u.actionVerb}`];
        if (u.targetSymbol) meta.push(`Symbol: ${u.targetSymbol}`);
        if (u.frameworkContext.length > 0) meta.push(`Frameworks: ${u.frameworkContext.join(', ')}`);
        lines.push(meta.join(' | '));
      }
      lines.push(clean(ctx.goal));
      return lines.join('\n');
    },
  });

  // STU Phase B: Semantic context from Layer 1 (entities, history) + Layer 2 (intent, constraints)
  registry.register({
    id: 'semantic-context',
    target: 'user',
    cache: 'ephemeral',
    priority: 22,
    render: (ctx) => {
      const u = ctx.understanding;
      // Only render if we have Layer 1+ data (resolvedEntities or semanticIntent)
      const hasEntities = u && 'resolvedEntities' in u && (u as SemanticTaskUnderstanding).resolvedEntities?.length;
      const hasIntent = u && 'semanticIntent' in u && (u as SemanticTaskUnderstanding).semanticIntent;
      if (!hasEntities && !hasIntent) return null;

      const stu = u as SemanticTaskUnderstanding;
      const lines = ['[SEMANTIC CONTEXT]'];

      // Resolved entities (Layer 1)
      for (const entity of stu.resolvedEntities ?? []) {
        lines.push(`  "${entity.reference}" → ${entity.resolvedPaths.join(', ')} (${entity.resolution})`);
      }

      // Historical profile
      if (stu.historicalProfile?.isRecurring) {
        lines.push(`  ⚠ Recurring issue — ${stu.historicalProfile.priorAttemptCount} prior attempts`);
        lines.push(`  Common failure oracles: ${stu.historicalProfile.commonFailureOracles.join(', ')}`);
      }

      // Semantic intent (Layer 2)
      const intent = stu.semanticIntent;
      if (intent) {
        // Goal summary — most important for worker orientation on long tasks
        if (intent.goalSummary) {
          lines.push(`  Summary: ${intent.goalSummary}`);
        }

        // Action steps — concrete guidance for the worker
        if (intent.steps?.length) {
          lines.push('  Steps:');
          for (const step of intent.steps) {
            lines.push(`    - ${step}`);
          }
        }

        // Success criteria — what "done" looks like
        if (intent.successCriteria?.length) {
          lines.push('  Done when:');
          for (const criterion of intent.successCriteria) {
            lines.push(`    ✓ ${criterion}`);
          }
        }

        // Affected components
        if (intent.affectedComponents?.length) {
          lines.push(`  Affected: ${intent.affectedComponents.join(', ')}`);
        }

        // Root cause hypothesis
        if (intent.rootCause) {
          lines.push(`  Root cause hypothesis: ${intent.rootCause}`);
        }

        lines.push(`  Intent: ${intent.primaryAction} — ${intent.scope}`);

        // Constraints with polarity
        for (const c of intent.implicitConstraints) {
          const prefix = c.polarity === 'must-not' ? 'MUST NOT:' : 'MUST:';
          lines.push(`  ${prefix} ${c.text}`);
        }

        // Ambiguities
        for (const a of intent.ambiguities) {
          lines.push(`  ⚠ Ambiguity: ${a.aspect} — ${a.interpretations.join(' / ')}`);
        }
      }

      // L0 vs L2 caveat (AI-1 gap fix)
      if (intent && stu.actionCategory) {
        const CATEGORY_ACTION_MAP: Record<string, string[]> = {
          mutation: [
            'add-feature',
            'bug-fix',
            'security-fix',
            'refactor',
            'api-migration',
            'dependency-update',
            'configuration',
            'performance-optimization',
            'accessibility',
          ],
          analysis: ['documentation'],
          investigation: ['investigation', 'flaky-test-diagnosis'],
          qa: ['test-improvement'],
        };
        const expected = CATEGORY_ACTION_MAP[stu.actionCategory] ?? [];
        if (!expected.includes(intent.primaryAction) && intent.primaryAction !== 'other') {
          lines.push(
            `  [CAVEAT] Rule-based classification (${stu.actionCategory}) differs from semantic analysis (${intent.primaryAction}). Prefer the structural classification for safety.`,
          );
        }
      }

      // Behavioral instruction for ambiguities
      if (intent?.ambiguities?.length) {
        lines.push('');
        lines.push('  INSTRUCTION: Where ambiguities exist, choose the SAFEST interpretation');
        lines.push('  (smallest scope, fewest side effects).');
      }

      return lines.join('\n');
    },
  });

  // Gap 1B: Surface acceptance criteria so generator optimizes for the same rubric critic evaluates
  registry.register({
    id: 'acceptance-criteria',
    target: 'user',
    cache: 'ephemeral',
    priority: 25,
    render: (ctx) => {
      const criteria = ctx.understanding?.acceptanceCriteria ?? [];
      if (criteria.length === 0) return null;
      const items = criteria
        .slice(0, 5)
        .map((c) => `  - ${clean(c)}`)
        .join('\n');
      return `[ACCEPTANCE CRITERIA]\n${items}`;
    },
  });

  registry.register({
    id: 'perception',
    target: 'user',
    cache: 'ephemeral',
    priority: 30,
    render: (ctx) => {
      const target = ctx.perception.taskTarget;
      const cone = ctx.perception.dependencyCone;
      const lines = [
        `[PERCEPTION]`,
        `Target: ${target.file}${target.symbol ? ` → ${target.symbol}` : ''} — ${clean(target.description)}`,
      ];

      // Gap 9B: Render dependency relationships explicitly (not just flat lists)
      if (cone.directImporters.length > 0) {
        lines.push(`Files that import target (will break if API changes): ${cone.directImporters.join(', ')}`);
      }
      if (cone.directImportees.length > 0) {
        lines.push(`Files target depends on (available APIs): ${cone.directImportees.join(', ')}`);
      }
      lines.push(`Blast radius: ${cone.transitiveBlastRadius} files`);

      // Gap 3B: Framework context
      if (ctx.perception.frameworkMarkers?.length) {
        lines.push(`Frameworks: ${ctx.perception.frameworkMarkers.join(', ')}`);
      }

      if (ctx.perception.diagnostics.typeErrors.length > 0) {
        const errors = ctx.perception.diagnostics.typeErrors
          .slice(0, 10)
          .map((e) => `  ${e.file}:${e.line}: ${clean(e.message)}`)
          .join('\n');
        lines.push('', `[DIAGNOSTICS]`, errors);
      }

      return lines.join('\n');
    },
  });

  // Gap 3C: File content previews for L1+ workers (avoids hallucinating file structure)
  registry.register({
    id: 'file-contents',
    target: 'user',
    cache: 'ephemeral',
    priority: 35,
    render: (ctx) => {
      if (!ctx.perception.fileContents?.length) return null;
      const sections = ctx.perception.fileContents.map((fc) => {
        const header = fc.truncated ? `${fc.file} (truncated)` : fc.file;
        return `--- ${header} ---\n${fc.content}`;
      });
      return `[FILE CONTENTS]\n${sections.join('\n\n')}`;
    },
  });

  registry.register({
    id: 'known-facts',
    target: 'user',
    cache: 'ephemeral',
    priority: 40,
    render: (ctx) => {
      if (ctx.perception.verifiedFacts.length === 0) return null;
      const facts = ctx.perception.verifiedFacts
        .slice(0, 10)
        .map((f) => {
          const tier = tierLabel(f.tierReliability);
          return `  ${f.target}: ${clean(f.pattern)} (${tier}, confidence: ${f.confidence.toFixed(2)}, oracle: ${f.oracleName})`;
        })
        .join('\n');
      return `[KNOWN FACTS]\n${facts}`;
    },
  });

  // Gap 1A: Surface user-provided constraints (previously silently dropped)
  registry.register({
    id: 'user-constraints',
    target: 'user',
    cache: 'ephemeral',
    priority: 45,
    render: (ctx) => {
      const userConstraints = ctx.understanding?.constraints ?? [];
      if (userConstraints.length === 0) return null;
      const items = userConstraints.map((c) => `  - ${clean(c)}`).join('\n');
      return `[USER CONSTRAINTS]\n${items}`;
    },
  });

  registry.register({
    id: 'constraints',
    target: 'user',
    cache: 'ephemeral',
    priority: 50,
    render: (ctx) => {
      if (ctx.memory.failedApproaches.length === 0) return null;
      const lines = ctx.memory.failedApproaches.map((f, idx) => {
        // Use structured format when classified failures are available
        if (f.classifiedFailures && f.classifiedFailures.length > 0) {
          const header = `  Attempt ${idx + 1}: ${clean(f.approach)}`;
          const details = f.classifiedFailures
            .map((cf) => {
              const loc = cf.file ? (cf.line ? `${cf.file}:${cf.line}` : cf.file) : '';
              const prefix = cf.severity === 'error' ? '✗' : '⚠';
              return `    ${prefix} ${cf.category}${loc ? `: ${loc}` : ''} — ${clean(cf.message)}${cf.suggestedFix ? `\n      → ${clean(cf.suggestedFix)}` : ''}`;
            })
            .join('\n');
          return `${header}\n${details}`;
        }
        // Fallback to flat format for backwards compatibility
        return `  - Do NOT try: ${clean(f.approach)} (rejected: ${clean(f.oracleVerdict)})`;
      });
      return `[FAILED APPROACHES]\n${lines.join('\n')}`;
    },
  });

  registry.register({
    id: 'hypotheses',
    target: 'user',
    cache: 'ephemeral',
    priority: 60,
    render: (ctx) => {
      const parts: string[] = [];

      if (ctx.memory.activeHypotheses.length > 0) {
        const hypotheses = ctx.memory.activeHypotheses
          .map((h) => `  - ${clean(h.hypothesis)} (confidence: ${h.confidence}, source: ${h.source})`)
          .join('\n');
        parts.push(`[HYPOTHESES]\n${hypotheses}`);
      }

      if (ctx.memory.unresolvedUncertainties.length > 0) {
        const uncertainties = ctx.memory.unresolvedUncertainties
          .map((u) => `  - ${clean(u.area)}: ${clean(u.suggestedAction)}`)
          .join('\n');
        parts.push(`[UNCERTAINTIES]\n${uncertainties}`);
      }

      return parts.length > 0 ? parts.join('\n\n') : null;
    },
  });

  registry.register({
    id: 'plan',
    target: 'user',
    cache: 'ephemeral',
    priority: 70,
    render: (ctx) => {
      if (!ctx.plan || ctx.plan.nodes.length === 0) return null;
      const steps = ctx.plan.nodes
        .map((n, i) => `  ${i + 1}. ${clean(n.description)} → ${n.targetFiles.join(', ')}`)
        .join('\n');
      return `[PLAN]\n${steps}`;
    },
  });

  registerConversationHistorySection(registry);

  return registry;
}

// ── Reasoning-task sections (Gap 4A) ──────────────────────────────────

/** Create registry for reasoning tasks — richer than the old 4-line system prompt. */
export function createReasoningRegistry(): PromptSectionRegistry {
  const registry = new PromptSectionRegistry();

  // ── System prompt ──
  registry.register({
    id: 'reasoning-role',
    target: 'system',
    cache: 'static',
    priority: 10,
    render: (ctx) => {
      const stu = ctx.understanding as SemanticTaskUnderstanding | undefined;
      const domain = stu?.taskDomain;
      const intent = stu?.taskIntent;

      // Code domains: Vinyan orchestrator framing
      if (isCodeDomain(domain)) {
        return `[ROLE]
You are a reasoning assistant in Vinyan, an autonomous orchestrator powered by Epistemic Orchestration.
Answer directly and concisely. Match the user's language naturally.
If uncertain, say what you don't know — never fabricate facts about the codebase.
Do NOT use JSON, code blocks for your answer, or LaTeX formatting.`;
      }

      // Execute intent: orchestrator framing — assess capability, act or explain limitation
      if (intent === 'execute') {
        return `[ROLE]
You are Vinyan, a task orchestrator.
When the user asks you to do something:
1. State the goal clearly (one sentence).
2. Check: do you have tools listed in this prompt that can accomplish this? If YES → propose the action.
3. If NO tools are available for this task → you MUST say "I don't have the ability to do that directly" FIRST, then suggest the single most direct way the user can do it themselves.
CRITICAL: You can NOT launch applications, open browsers, run shell commands, or interact with the OS unless a tool is explicitly listed above. Do not say "ได้ครับ" or "Sure" for actions you cannot perform.
Be concise. One recommended approach — not a tutorial of all options.
Match the user's language naturally. Be specific to their platform.
Never reveal your underlying model name or provider — you are Vinyan.
Do NOT use JSON, code blocks for your answer, or LaTeX formatting.`;
      }

      // Converse intent: lightweight friendly assistant
      if (intent === 'converse') {
        return `[ROLE]
You are Vinyan, a friendly assistant. Respond naturally and briefly. Match the user's language.
Never reveal your underlying model name or provider — you are Vinyan.
Do NOT use JSON, code blocks for your answer, or LaTeX formatting.`;
      }

      // Inquire intent (default): knowledge assistant
      return `[ROLE]
You are Vinyan, a helpful assistant. Answer directly and concisely. Match the user's language naturally.
Never reveal your underlying model name or provider — you are Vinyan.
Consider the user's operating environment when answering. Be specific to their platform rather than listing all platforms.
If uncertain, say what you don't know.
Do NOT claim to have tools, file access, or capabilities that are not explicitly listed in this prompt.
Do NOT use JSON, code blocks for your answer, or LaTeX formatting.`;
    },
  });

  registry.register({
    id: 'reasoning-tools',
    target: 'system',
    cache: 'static',
    priority: 20,
    render: (ctx) => {
      // R2 (§5): L0-L1 must NOT receive tool descriptions — prevents hallucinated tool calls.
      if (ctx.routingLevel != null && ctx.routingLevel < 2) return null;

      let tools = ctx.perception.runtime.availableTools;
      if (!tools.length) return null;

      // A6 defense-in-depth: filter tools by task domain.
      // code-reasoning gets read-only tools only; general-reasoning gets none.
      const domain = (ctx.understanding as SemanticTaskUnderstanding)?.taskDomain;
      if (domain === 'general-reasoning' || domain === 'conversational') {
        // General reasoning & conversational: no tools (answer from knowledge)
        return null;
      }
      if (domain === 'code-reasoning') {
        // Code reasoning: read-only tools only
        tools = tools.filter((t) => READONLY_TOOLS.has(t));
        if (!tools.length) return null;
      }
      // code-mutation: all tools (default)

      const lines = [`[AVAILABLE TOOLS]`, [...tools].sort().join(', ')];
      lines.push(`\nRuntime: ${process.platform} (${process.arch})`);
      lines.push('You may propose tool calls for information gathering.');
      return lines.join('\n');
    },
  });

  // Environment context — available for ALL domains (OS info is always relevant)
  registry.register({
    id: 'reasoning-environment',
    target: 'system',
    cache: 'ephemeral',
    priority: 25,
    render: (ctx) => {
      const os = ctx.perception.runtime.os;
      if (!os) return null;
      const osName = os === 'darwin' ? 'macOS' : os === 'win32' ? 'Windows' : os === 'linux' ? 'Linux' : os;
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `[ENVIRONMENT]\nPlatform: ${osName} (${process.arch})\nCurrent date: ${dateStr}, ${timeStr}`;
    },
  });

  // ── User prompt ──
  registry.register({
    id: 'reasoning-instructions',
    target: 'user',
    cache: 'session',
    priority: 10,
    render: (ctx) => (ctx.instructions ? `[PROJECT INSTRUCTIONS]\n${clean(ctx.instructions.content)}` : null),
  });

  registry.register({
    id: 'reasoning-task',
    target: 'user',
    cache: 'ephemeral',
    priority: 20,
    render: (ctx) => {
      const stu = ctx.understanding as SemanticTaskUnderstanding | undefined;
      const domain = stu?.taskDomain;
      const intent = stu?.taskIntent;

      // General-reasoning and conversational: send raw goal without [TASK] header.
      // Structured headers ([TASK], [ROLE]) confuse small models when followed by
      // non-Latin text — they treat the header as a template and the goal as empty.
      // The system prompt already frames the assistant role; no header needed.
      if (!isCodeDomain(domain) && intent !== 'execute') {
        return clean(ctx.goal);
      }

      // Code domains and execute intent: keep structured format with metadata.
      const lines = ['[TASK]'];
      if (ctx.understanding && isCodeDomain(domain)) {
        // Code domains: full metadata (action verb, symbol, frameworks)
        const u = ctx.understanding;
        const meta: string[] = [`Action: ${u.actionVerb}`];
        if (u.targetSymbol) meta.push(`Symbol: ${u.targetSymbol}`);
        if (u.frameworkContext.length > 0) meta.push(`Frameworks: ${u.frameworkContext.join(', ')}`);
        lines.push(meta.join(' | '));
      } else if (intent === 'execute' && ctx.understanding) {
        // Execute intent: explicit goal framing for the orchestrator
        lines.push(`Goal: ${ctx.understanding.actionVerb} — ${clean(ctx.goal)}`);
      }
      lines.push(clean(ctx.goal));
      return lines.join('\n');
    },
  });

  // Reasoning tasks with targetFiles get perception (Gap 7A)
  registry.register({
    id: 'reasoning-perception',
    target: 'user',
    cache: 'ephemeral',
    priority: 30,
    render: (ctx) => {
      // Non-code domains don't need codebase context
      const domain = (ctx.understanding as SemanticTaskUnderstanding)?.taskDomain;
      if (!isCodeDomain(domain)) return null;
      const target = ctx.perception.taskTarget;
      const cone = ctx.perception.dependencyCone;
      // Skip if no meaningful perception
      if (!target.file && cone.directImporters.length === 0 && cone.directImportees.length === 0) return null;
      const lines = ['[CODEBASE CONTEXT]'];
      if (target.file) lines.push(`Target: ${target.file}`);
      if (cone.directImporters.length > 0) lines.push(`Imported by: ${cone.directImporters.join(', ')}`);
      if (cone.directImportees.length > 0) lines.push(`Depends on: ${cone.directImportees.join(', ')}`);
      if (cone.transitiveBlastRadius > 0) lines.push(`Blast radius: ${cone.transitiveBlastRadius} files`);
      if (ctx.perception.frameworkMarkers?.length) {
        lines.push(`Frameworks: ${ctx.perception.frameworkMarkers.join(', ')}`);
      }
      if (ctx.perception.diagnostics.typeErrors.length > 0) {
        const errors = ctx.perception.diagnostics.typeErrors
          .slice(0, 5)
          .map((e) => `  ${e.file}:${e.line}: ${clean(e.message)}`)
          .join('\n');
        lines.push(`\nType errors:\n${errors}`);
      }
      return lines.join('\n');
    },
  });

  // File contents for reasoning too (Gap 3C)
  registry.register({
    id: 'reasoning-file-contents',
    target: 'user',
    cache: 'ephemeral',
    priority: 35,
    render: (ctx) => {
      // Non-code domains don't need file contents
      const domain = (ctx.understanding as SemanticTaskUnderstanding)?.taskDomain;
      if (!isCodeDomain(domain)) return null;
      if (!ctx.perception.fileContents?.length) return null;
      const sections = ctx.perception.fileContents.map((fc) => {
        const header = fc.truncated ? `${fc.file} (truncated)` : fc.file;
        return `--- ${header} ---\n${fc.content}`;
      });
      return `[FILE CONTENTS]\n${sections.join('\n\n')}`;
    },
  });

  // Verified facts for reasoning
  registry.register({
    id: 'reasoning-facts',
    target: 'user',
    cache: 'ephemeral',
    priority: 40,
    render: (ctx) => {
      if (ctx.perception.verifiedFacts.length === 0) return null;
      const facts = ctx.perception.verifiedFacts
        .slice(0, 10)
        .map((f) => {
          const tier = tierLabel(f.tierReliability);
          return `  ${f.target}: ${clean(f.pattern)} (${tier}, confidence: ${f.confidence.toFixed(2)})`;
        })
        .join('\n');
      return `[VERIFIED FACTS]\n${facts}`;
    },
  });

  // User constraints
  registry.register({
    id: 'reasoning-user-constraints',
    target: 'user',
    cache: 'ephemeral',
    priority: 45,
    render: (ctx) => {
      const userConstraints = ctx.understanding?.constraints ?? [];
      if (userConstraints.length === 0) return null;
      const items = userConstraints.map((c) => `  - ${clean(c)}`).join('\n');
      return `[USER CONSTRAINTS]\n${items}`;
    },
  });

  // Failed approaches
  registry.register({
    id: 'reasoning-failed',
    target: 'user',
    cache: 'ephemeral',
    priority: 50,
    render: (ctx) => {
      if (ctx.memory.failedApproaches.length === 0) return null;
      const lines = ctx.memory.failedApproaches.map((f, idx) => {
        if (f.classifiedFailures && f.classifiedFailures.length > 0) {
          const header = `  Attempt ${idx + 1}: ${clean(f.approach)}`;
          const details = f.classifiedFailures
            .map((cf) => {
              const loc = cf.file ? (cf.line ? `${cf.file}:${cf.line}` : cf.file) : '';
              const prefix = cf.severity === 'error' ? '✗' : '⚠';
              return `    ${prefix} ${cf.category}${loc ? `: ${loc}` : ''} — ${clean(cf.message)}`;
            })
            .join('\n');
          return `${header}\n${details}`;
        }
        return `  - Avoid: ${clean(f.approach)} (reason: ${clean(f.oracleVerdict)})`;
      });
      return `[CONTEXT]\n${lines.join('\n')}`;
    },
  });

  registerConversationHistorySection(registry);

  return registry;
}

// ── Shared: Conversation History section ────────────────────────────

/** Register the conversation-history prompt section (shared between code and reasoning registries). */
function registerConversationHistorySection(registry: PromptSectionRegistry): void {
  registry.register({
    id: 'conversation-history',
    target: 'user',
    cache: 'ephemeral',
    priority: 15, // early in user prompt, before task/perception/plan
    render: (ctx) => {
      if (!ctx.conversationHistory?.length) return null;
      const lines = ctx.conversationHistory.map((entry, i) => {
        const turnNum = i + 1;
        const role = entry.role === 'user' ? 'User' : 'Assistant';
        // Truncate long entries to keep prompt manageable
        const content = entry.content.length > 2000
          ? `${entry.content.slice(0, 2000)}... (truncated)`
          : entry.content;
        return `[Turn ${turnNum}] ${role}: ${clean(content)}`;
      });
      return `[CONVERSATION HISTORY]\nThis is a multi-turn conversation. Prior turns for context:\n${lines.join('\n')}`;
    },
  });
}
