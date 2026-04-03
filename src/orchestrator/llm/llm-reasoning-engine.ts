/**
 * LLMReasoningEngine — adapter that wraps any LLMProvider as a ReasoningEngine.
 *
 * This is the bridge between the legacy LLMProvider interface and the RE-agnostic
 * ReasoningEngine contract. LLMs are one class of RE; future AGI/symbolic systems
 * implement ReasoningEngine directly without going through LLMProvider.
 *
 * Axiom A3: The adapter maps provider-specific stop reasons to generic terminationReason
 * values so the Orchestrator never depends on vendor vocabulary.
 */
import type { CacheControl, LLMProvider, LLMRequest, RERequest, REResponse, ReasoningEngine, RoutingLevel, ThinkingConfig } from '../types.ts';
import type { LLMProviderRegistry } from './provider-registry.ts';

/** Default capabilities for LLM-class REs that don't declare their own. */
const DEFAULT_LLM_CAPABILITIES = ['code-generation', 'reasoning', 'tool-use', 'text-generation'];

const LEVEL_TO_TIER: Record<RoutingLevel, LLMProvider['tier'] | null> = {
  0: null,
  1: 'fast',
  2: 'balanced',
  3: 'powerful',
};

/** Wraps an LLMProvider as a ReasoningEngine. Backward-compatible adapter. */
export class LLMReasoningEngine implements ReasoningEngine {
  readonly engineType = 'llm' as const;
  readonly id: string;
  readonly capabilities: string[];
  readonly tier: 'fast' | 'balanced' | 'powerful';
  readonly maxContextTokens?: number;

  constructor(private readonly provider: LLMProvider) {
    this.id = provider.id;
    this.tier = provider.tier;
    this.capabilities = provider.capabilities?.length
      ? provider.capabilities
      : DEFAULT_LLM_CAPABILITIES;
    this.maxContextTokens = provider.maxContextTokens;
  }

  async execute(req: RERequest): Promise<REResponse> {
    const opts = req.providerOptions ?? {};
    const llmReq: LLMRequest = {
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      tools: req.tools,
      messages: req.messages,
      thinking: opts.thinking as ThinkingConfig | undefined,
      cacheControl: opts.cacheControl as CacheControl | undefined,
    };

    const res = await this.provider.generate(llmReq);

    return {
      content: res.content,
      toolCalls: res.toolCalls,
      tokensUsed: res.tokensUsed,
      engineId: this.id,
      terminationReason: mapStopReason(res.stopReason),
      thinking: res.thinking,
      providerMeta: { model: res.model },
    };
  }

  /** Expose the underlying LLMProvider for cases that need raw access (e.g. agent-loop). */
  get llmProvider(): LLMProvider {
    return this.provider;
  }
}

function mapStopReason(r: 'end_turn' | 'tool_use' | 'max_tokens'): REResponse['terminationReason'] {
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'limit_reached';
  return 'completed';
}

/**
 * RE-agnostic registry — stores any ReasoningEngine (LLM, symbolic, AGI, etc.).
 * Replaces tier-only selection with capability-first selection + tier fallback.
 *
 * Backward compat: fromLLMRegistry() wraps an existing LLMProviderRegistry so
 * all existing code continues to work without modification.
 */
export class ReasoningEngineRegistry {
  private engines = new Map<string, ReasoningEngine>();

  register(engine: ReasoningEngine): void {
    this.engines.set(engine.id, engine);
  }

  /** Select by routing level — tier-based fallback for backward compat. */
  selectForRoutingLevel(level: RoutingLevel): ReasoningEngine | undefined {
    const tier = LEVEL_TO_TIER[level];
    if (!tier) return undefined; // L0 — no RE needed
    return this.selectByTier(tier);
  }

  selectByTier(tier: 'fast' | 'balanced' | 'powerful'): ReasoningEngine | undefined {
    for (const engine of this.engines.values()) {
      if (engine.tier === tier) return engine;
    }
    return undefined;
  }

  /**
   * Capability-first selection — the primary path for future non-LLM REs.
   * Falls back to tier-based if no capability-declaring engine is found.
   */
  selectByCapability(required: string[], preferredTier?: 'fast' | 'balanced' | 'powerful'): ReasoningEngine | undefined {
    const capable = Array.from(this.engines.values()).filter(
      (e) => required.every((c) => e.capabilities.includes(c)),
    );
    if (capable.length === 0) return undefined;
    if (preferredTier) {
      const tiered = capable.find((e) => e.tier === preferredTier);
      if (tiered) return tiered;
    }
    return capable[0];
  }

  /**
   * Select by worker/engine ID.
   * Resolution order: exact → strip "worker-" prefix → prefix match.
   */
  selectById(id: string): ReasoningEngine | undefined {
    const exact = this.engines.get(id);
    if (exact) return exact;
    const stripped = id.startsWith('worker-') ? id.slice(7) : id;
    const byStripped = this.engines.get(stripped);
    if (byStripped) return byStripped;
    for (const engine of this.engines.values()) {
      if (stripped.startsWith(engine.id) || engine.id.startsWith(stripped)) return engine;
    }
    return undefined;
  }

  listEngines(): ReasoningEngine[] {
    return Array.from(this.engines.values());
  }

  get(id: string): ReasoningEngine | undefined {
    return this.engines.get(id);
  }

  /**
   * Build a ReasoningEngineRegistry from an existing LLMProviderRegistry.
   * Drop-in replacement — wraps all LLM providers as LLMReasoningEngine adapters.
   */
  static fromLLMRegistry(llmRegistry: LLMProviderRegistry): ReasoningEngineRegistry {
    const reg = new ReasoningEngineRegistry();
    for (const provider of llmRegistry.listProviders()) {
      reg.register(new LLMReasoningEngine(provider));
    }
    return reg;
  }
}
