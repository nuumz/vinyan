# Memory And Prompt Architecture — Deep Research

> **Document boundary**: This document owns the research landscape, design principles, and architectural patterns for agent memory and prompt assembly systems. For Vinyan-specific implementation decisions, see [decisions.md](../architecture/decisions.md). For existing Claude Code analysis, see [claude-code-architecture-lessons.md](../analysis/claude-code-architecture-lessons.md) §3.

## Executive Summary

Agent memory architecture is converging on a **tiered, role-separated** model where different memory types (instruction, working, episodic, semantic) serve distinct governance purposes and reside in distinct substrates. The most successful production systems (Claude Code, Mem0, MemGPT/Letta) share three principles: (1) keep the simple thing working first, (2) separate memory by lifecycle and trust, (3) make prompt assembly a first-class architectural subsystem rather than string concatenation.

Prompt caching transforms the economics of memory-heavy prompts — Anthropic's prefix-based cache achieves 90% cost reduction on repeated static content, but demands **cache-aware prompt structure** (static prefix → dynamic suffix, breakpoint placement on stable boundaries).

For Vinyan specifically: the current `PromptAssembler` and `WorkingMemory` are solid foundations. The primary architectural gaps are (1) no persistent preference/instruction memory across sessions, (2) no cache-boundary-aware prompt ordering, and (3) no progressive compaction strategy for long-running agentic sessions.

**Confidence**: HIGH (≥5 primary sources, multiple production-validated systems).

---

## 1. Technical Landscape

### 1.1 Memory Taxonomy — Academic Foundations

The cognitive science mapping established by Weng (2023) and formalized in CoALA (Sumers & Yao et al., 2023) provides the canonical framework:

| Memory Type | Cognitive Analog | LLM Mapping | Persistence | Retrieval |
|---|---|---|---|---|
| **Sensory** | Iconic/echoic | Embedding representations | Transient | Implicit in weights |
| **Short-term / Working** | 7±2 items, 20-30s | In-context window | Per-request | Full attention |
| **Long-term Episodic** | Event memory | Conversation logs, traces | Cross-session | Retrieval (recency + relevance) |
| **Long-term Semantic** | Facts & concepts | Knowledge bases, world graphs | Persistent | Content-addressed / vector |
| **Long-term Procedural** | Skills & routines | Tool definitions, skills | Persistent | Pattern-matched / rule-based |

— Weng, 2023; Sumers et al., 2023; Zhang et al., 2024

**Key insight from Zhang et al. (2024)**: The survey of 39 papers identifies three design axes for agent memory — *structure* (flat vs. hierarchical vs. graph), *operations* (read/write/reflect/forget), and *evaluation* (task completion, personalization, coherence). No single structure dominates; the right choice depends on whether the agent needs temporal coherence (→ episodic), factual grounding (→ semantic), or behavioral adaptation (→ procedural).

### 1.2 Production Systems — Competitive Landscape

| System | Memory Architecture | Retrieval Strategy | Persistence | Key Innovation |
|---|---|---|---|---|
| **Claude Code** | 3-tier: CLAUDE.md (instruction), Auto Memory (semantic), Session (episodic) | Agentic search (glob→grep→read) | File-backed | Cache-aware prompt assembly; no embeddings |
| **MemGPT / Letta** | OS-inspired: main context (RAM) + archival storage (disk) + recall storage (conversation) | Self-managed paging (LLM decides when to page in/out) | SQLite + vector store | Virtual context management; interrupts for control flow |
| **Mem0** | Multi-level: User, Session, Agent memories | Vector search + graph + reranker | Managed cloud / self-hosted | +26% accuracy on LOCOMO benchmark; 90% fewer tokens vs full context |
| **Generative Agents** | Memory stream (all observations) + reflections (synthesized) | Recency × importance × relevance scoring | External DB | Reflection mechanism; emergent social behavior |
| **LangGraph** | Checkpointed state + cross-thread "Store" for long-term | Namespace-based key-value | Configurable backends | Thread-level vs cross-thread separation |
| **OpenAI Agents SDK** | Conversation context only (no built-in persistent memory) | — | None by default | Relies on external memory tools |

— Park et al., 2023; Packer et al., 2023; Mem0 (2025); LangGraph docs; Anthropic (2024)

### 1.3 The "Simple Thing" Convergence

A striking finding across interviews with Claude Code engineers:

> "We had all these crazy ideas about memory architectures... in the end, the thing we did is ship the simplest thing — a file that has some stuff, auto-read into context." — Boris Cherny, Latent Space podcast (May 2025)

> "Agentic search outperformed everything. By a lot." — Boris Cherny, on why Claude Code uses glob→grep→read instead of RAG/embeddings

> "Everything is the model... as the model gets better, it subsumes everything else." — Boris Cherny, on knowledge graphs

This "simple thing first" philosophy is validated by production data:
- **CLAUDE.md compliance**: <200 lines → 92-96% instruction following; >400 lines → 71% (karaxai, 2025)
- **Auto-compaction**: Triggered at ~83.5% context (167K/200K tokens). Lossy — preserves structure and recent exchanges, loses exact code/variable names/reasoning chains

---

## 2. Prompt Assembly Architecture

### 2.1 Claude Code's Prompt Assembly Pattern

The most architecturally sophisticated prompt system in production follows this structure:

```
┌─ tools (cacheable, changes rarely)
│  └─ cache breakpoint 1
├─ system prompt
│  ├─ STATIC: role, output format, base instructions
│  ├─ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ←── cache boundary
│  ├─ DYNAMIC: memory, language, output style, MCP instructions, session guidance
│  └─ cache breakpoint 2
└─ messages
   ├─ user context (CLAUDE.md injected as <system-reminder> tags, NOT in system prompt)
   ├─ conversation history
   └─ cache breakpoint 3 (automatic, moves forward each turn)
```

**Critical design decisions**:
1. **CLAUDE.md in user messages, not system prompt** — enables per-turn freshness without invalidating system cache
2. **Static/dynamic boundary** — everything above the boundary is cache-stable (~92% hit rate)
3. **Progressive disclosure for skills** — only name+description loaded; full content on demand (saves thousands of tokens)
4. **Tool Search activation** — when tools consume >10% of context, switches to search-based tool loading

— karaxai deep dive (2025); prompts.ts, queryContext.ts analysis

### 2.2 Prompt Caching Economics

Anthropic's prompt caching fundamentally changes the cost calculus for prompt design:

| Metric | Value |
|---|---|
| Cache read cost | 10% of base input token price |
| Cache write cost (5min TTL) | 125% of base input token price |
| Cache write cost (1hr TTL) | 200% of base input token price |
| Min cacheable tokens (Opus 4.6) | 4,096 |
| Min cacheable tokens (Sonnet 4.6) | 2,048 |
| Max breakpoints | 4 per request |
| Lookback window | 20 blocks from each breakpoint |

**Cache hierarchy**: `tools` → `system` → `messages`. Changes at any level invalidate that level and all subsequent levels.

**Key engineering constraint**: Cache writes happen *only* at breakpoints. Placing a breakpoint on content that changes every request (e.g., timestamps) means no cache hits ever. Place breakpoints on the last stable block.

**Multi-turn automatic caching**: The breakpoint moves forward automatically. Each new request reads everything before the breakpoint from cache, writes only the new content. This works as long as each turn adds fewer than 20 blocks (the lookback window limit).

— Anthropic prompt caching docs (2025)

### 2.3 Vinyan's Current Prompt Assembly

Vinyan's `PromptAssembler` (`src/orchestrator/llm/prompt-assembler.ts`) follows a simpler model:

| Prompt Section | Position | Content |
|---|---|---|
| **System** (code tasks) | ROLE + OUTPUT FORMAT + AVAILABLE TOOLS + ORACLE MANIFEST | Static per routing level |
| **User** (code tasks) | TASK + PERCEPTION + DIAGNOSTICS + VERIFIED FACTS + CONSTRAINTS + HYPOTHESES + UNCERTAINTIES + PLAN | Dynamic per task |
| **System** (reasoning tasks) | Minimal instruction prompt | Static |
| **User** (reasoning tasks) | Goal + CONTEXT (failed approaches) | Dynamic per task |

All untrusted text passes through `sanitizeForPrompt()` — a guardrail pattern that other systems (Claude Code, MemGPT) lack in their prompt assembly layer.

**Gap vs. Claude Code**: No cache-boundary awareness. The system prompt includes tools (which change rarely) and oracle manifest (static) mixed with available tools list (could change per-run). No `CacheControl` markers are emitted despite the type being defined in `types.ts`.

---

## 3. Memory System Design Principles

### 3.1 Principle: Separate Memory by Lifecycle and Trust

Every production system that scales past single-session use separates memory into at least three distinct stores with different governance:

| Property | Instruction Memory | Working Memory | Episodic Memory | Semantic Memory |
|---|---|---|---|---|
| **Lifecycle** | Persistent (human-authored) | Per-task (ephemeral) | Per-session → archived | Cross-session (verified) |
| **Trust level** | High (user intent) | Low (LLM-generated) | Low (may hallucinate) | Medium (oracle-verified) |
| **Mutation** | Human only | Agent freely | Append-only → compacted | Hash-gated updates |
| **Prompt injection risk** | Low (authored by owner) | HIGH (re-entering LLM output) | HIGH (summarization drift) | Medium (oracle-filtered) |
| **Eviction policy** | Manual | Bounded arrays + confidence eviction | Compaction (lossy) | TTL + hash invalidation |

Claude Code's CLAUDE.md pattern (instruction memory) is the most battle-tested: a file-backed, human-authored document injected per-turn. Its power comes from *simplicity* — no database, no retrieval, no embedding. Its limitation is also simplicity — compliance degrades linearly with length.

Vinyan's `WorkingMemory` class already implements bounded arrays with confidence-based eviction (failed approaches evict by lowest confidence, hypotheses by lowest confidence, uncertainties/facts by FIFO). This is more sophisticated than Claude Code's approach.

### 3.2 Principle: Retrieval Strategy Must Match the Domain

| Domain | Best Retrieval | Why | Example |
|---|---|---|---|
| Code navigation | Agentic search (grep/glob) | Exact symbol matching; structure matters more than semantics | Claude Code |
| Conversational personalization | Vector similarity + reranker | Semantic matching across paraphrased preferences | Mem0 |
| Multi-agent social simulation | Recency × importance × relevance | Temporal dynamics critical for believable behavior | Generative Agents |
| Epistemic fact verification | Content-addressed hash lookup | Deterministic; no approximate matching acceptable | Vinyan World Graph |
| Virtual context paging | LLM self-directed recall | Agent knows what it needs; can't pre-determine retrieval keys | MemGPT |

**Vinyan's position**: The World Graph's content-addressed lookup (SHA-256 hash binding) is exactly right for epistemic facts — no other system in the landscape provides this level of deterministic truth-binding. The gap is in softer memory types where hash-binding is too rigid.

### 3.3 Principle: Compaction is Lossy — Design for What Survives

All production systems with sessions longer than ~100K tokens implement some form of compaction. The loss characteristics vary:

| System | Compaction Trigger | What Survives | What's Lost |
|---|---|---|---|
| **Claude Code** | ~83.5% context (167K/200K) | Broad structure, conclusions, recent exchanges | Exact code, variable names, reasoning chains |
| **MemGPT** | Main context overflow | LLM-selected important memories paged to archival | Older conversation details (retrievable on demand) |
| **Generative Agents** | Periodic (every N observations) | Higher-level reflections synthesized by LLM | Raw observation details |
| **Vinyan (current)** | None — bounded arrays only | Most recent + highest confidence entries | Evicted low-confidence/old entries |

Claude Code's compaction is "just ask Claude to summarize" — no complex algorithms. But this creates a known failure mode: the agent forgets exact code it wrote earlier in the session, leading to re-reads and wasted tokens.

Vinyan's `WorkingMemory` eviction is more principled (confidence-weighted) but doesn't address the *conversation history* compaction problem at all — that's currently delegated to the LLM provider's handling.

---

## 4. System Architecture — How It Fits Together

### 4.1 Canonical Agent Memory Architecture

Synthesizing across all studied systems:

```
┌──────────────────────────────────────────────────────────────────┐
│                    PROMPT ASSEMBLY LAYER                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Static   │ │ Instruc- │ │ Dynamic  │ │ Tool     │          │
│  │ System   │ │ tion     │ │ Context  │ │ Registry │          │
│  │ Core     │ │ Memory   │ │ (session)│ │ Deltas   │          │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘          │
│       │            │            │            │                  │
│  ═════╪════════════╪════════════╪════════════╪═══════           │
│  CACHE│BOUNDARY    │            │            │                  │
│       ▼            ▼            ▼            ▼                  │
│  ┌────────────────────────────────────────────────┐             │
│  │              Assembled Prompt                   │             │
│  └────────────────────┬───────────────────────────┘             │
└───────────────────────┼─────────────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────────────┐
│                MEMORY SUBSTRATE LAYER            │
│                        │                                        │
│  ┌──────────┐  ┌──────┴──────┐  ┌──────────┐  ┌──────────┐   │
│  │ Working  │  │ Episodic    │  │ Semantic  │  │ Procedu- │   │
│  │ Memory   │  │ Store       │  │ Store     │  │ ral      │   │
│  │ (bounded │  │ (session    │  │ (facts,   │  │ Store    │   │
│  │  arrays) │  │  history,   │  │  hash-    │  │ (skills, │   │
│  │          │  │  compacted) │  │  bound)   │  │  rules)  │   │
│  └──────────┘  └─────────────┘  └──────────┘  └──────────┘   │
│                                                                 │
│  Governance: Eviction policies, compaction, hash validation,    │
│              TTL, cascade invalidation                          │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Vinyan-Specific Architecture Mapping

| Architecture Component | Current Vinyan | Recommended Evolution |
|---|---|---|
| **Static System Core** | `buildCodeSystemPrompt()` — role + tools + oracle manifest | Add `CacheControl` markers at stable boundaries |
| **Instruction Memory** | Not implemented | File-backed VINYAN.md (user/project/machine scopes) |
| **Working Memory** | `WorkingMemory` class — bounded, confidence-evicted | Already ahead of competition; add compaction for conversation history |
| **Semantic Store** | `WorldGraph` — content-addressed facts with hash binding | Mature; add temporal decay for staleness |
| **Episodic Store** | `TraceCollector` (Phase 3) — traces, prediction errors | Add session summary compaction capability |
| **Procedural Store** | `SkillStore` (Phase 2) — cached successful approaches | Future: progressive disclosure pattern |
| **Prompt Assembly** | `assemblePrompt()` — system + user prompt builder | Add cache-boundary awareness; separate tool definitions |
| **Compaction** | None (except WorkingMemory eviction) | Add transcript partitioning (already typed: `TranscriptPartition` in types.ts) |

### 4.3 Data Contract — Prompt Assembly Output

The current `AssembledPrompt` interface:
```typescript
interface AssembledPrompt {
  systemPrompt: string;
  userPrompt: string;
}
```

A cache-aware extension would look like:
```typescript
interface CacheAwarePrompt {
  // Ordered by cache hierarchy: tools → system → messages
  tools: Array<{ definition: object; cacheControl?: CacheControl }>;
  systemBlocks: Array<{
    content: string;
    cacheControl?: CacheControl;  // mark stable blocks
    role: 'static' | 'dynamic';
  }>;
  userBlocks: Array<{
    content: string;
    cacheControl?: CacheControl;
    source: 'instruction-memory' | 'perception' | 'working-memory' | 'plan';
  }>;
}
```

This preserves the existing separation while enabling the LLM provider layer to emit proper cache breakpoints.

---

## 5. Critical Analysis

### 5.1 Scalability Limitations

**Context window ceiling**: All current approaches hit a hard limit. Claude Code's 200K window enables ~83.5% utilization before compaction, but compaction is lossy. MemGPT's virtual paging adds latency per page-in/page-out operation. No current system handles unbounded sessions gracefully.

**Token economics at scale**: Mem0 claims 90% token reduction vs. full context. Claude Code's prompt caching achieves ~90% cost reduction on repeated static content. But these savings are additive only when the memory architecture supports stable prefixes — a requirement that constrains prompt design.

**Memory retrieval latency**: Agentic search (Claude Code) scales O(n) with workspace size — acceptable for codebases but problematic at 100K+ files. Vector search (Mem0) scales O(log n) but introduces semantic fuzziness. Content-addressed lookup (Vinyan) is O(1) but only works for known facts.

### 5.2 Security Risks

**Prompt injection via memory**: Any system that re-injects LLM-generated content into prompts creates an injection surface. Rankings by attack surface:

| Memory Type | Injection Risk | Mitigation |
|---|---|---|
| Instruction memory (human-authored) | Low | Owner controls content |
| Working memory (LLM-generated, re-enters prompt) | HIGH | Vinyan: `sanitizeForPrompt()` — one of the only systems to do this |
| Episodic/compacted summaries | HIGH | Summarizer LLM can amplify injected instructions |
| Semantic facts (oracle-verified) | Medium | Oracle verification filters some attacks |
| User-provided preferences | Medium-HIGH | User may be adversarial in multi-tenant scenarios |

Vinyan's guardrail-based sanitization in the prompt assembler is a genuine differentiator — Claude Code, MemGPT, and Mem0 do not sanitize at the prompt assembly boundary.

### 5.3 Agentic Failure Modes

1. **Compaction amnesia**: After lossy compaction, the agent forgets specific code changes it made earlier, leading to re-reads (observed in Claude Code) or contradictory edits.

2. **Memory bloat → prompt degradation**: As instruction memory grows, compliance drops nonlinearly (Claude Code: 92% at <200 lines → 71% at >400 lines). This is a fundamental attention-degradation problem.

3. **Working memory eviction thrashing**: In tight retry loops, valuable failed-approach records can be evicted before the agent has enough evidence to change strategy. Vinyan's confidence-weighted eviction mitigates this better than FIFO.

4. **Stale fact persistence**: Facts verified at time T may become invalid by time T+Δ without any file change (e.g., external API behavior change). Hash-binding catches file changes but not semantic drift.

5. **Cross-session context loss**: No production system fully solves "what should the agent remember from last session?" File-based approaches (CLAUDE.md) require human curation. Automatic approaches (Mem0) require semantic understanding of what's worth retaining.

### 5.4 Open Questions

1. **When do knowledge graphs beat flat files?** Boris Cherny (Anthropic) argues "everything is the model" — as models improve, structured memory becomes less valuable. The Generative Agents work and GraphRAG suggest the opposite for multi-entity domains. Vinyan's World Graph is a bet on structured memory; its value increases with task complexity.

2. **Optimal compaction granularity**: Should compaction preserve the last N turns verbatim + summarize earlier turns (Claude Code approach)? Or should it preserve all high-evidence turns regardless of recency (Vinyan's `TranscriptPartition` concept)? The evidence-first approach aligns with A5 (tiered trust) but hasn't been validated at scale.

3. **Cross-agent memory sharing**: In multi-worker systems (Vinyan Phase 4), should workers share memory? MemGPT and Generative Agents allow it; Claude Code prohibits it (each agent session is independent). Vinyan's A1 (epistemic separation) argues for isolation, but A4 (content-addressed truth) enables safe sharing of verified facts.

4. **Memory should be model-agnostic**: Current prompt caching is provider-specific (Anthropic's mechanics differ from OpenAI's). Memory architecture should abstract over caching differences, but no framework does this well yet.

---

## 6. Recommendations for Vinyan

### 6.1 High-Value, Low-Risk

1. **Add cache-boundary markers to PromptAssembler** — split system prompt into static core (cache breakpoint) + dynamic perception. The `CacheControl` type already exists in `types.ts`.

2. **Implement instruction memory** — file-backed `VINYAN.md` pattern (following Claude Code's proven approach). Inject as user-message `<system-reminder>` tags, not in system prompt, to preserve cache stability.

3. **Wire `TranscriptPartition`** — the type already exists in `types.ts`. Implement evidence-first compaction: retain oracle verdicts and verification evidence; compact narrative turns.

### 6.2 Medium-Value, Medium-Risk

4. **Progressive disclosure for tool definitions** — when tool count × tokens > configurable threshold, switch to search-based tool loading (Claude Code's pattern). Saves 4-6K tokens per MCP server.

5. **Add temporal decay to World Graph facts** — columns `valid_until` and `decay_model` already exist in the schema. Wire them into `confidence` scoring at read time.

### 6.3 Research-Stage

6. **Cross-worker fact sharing** — allow workers to read (but not write) World Graph facts from other workers' sessions. A4 makes this safe; A1 requires reading-worker to not self-evaluate shared facts.

7. **Automatic preference extraction** — after N sessions, propose instruction memory updates based on observed user patterns (like Mem0's approach, but governed by user approval).

---

## 7. Source Index

| # | Source | Type | Year | Confidence |
|---|---|---|---|---|
| 1 | Weng, "LLM Powered Autonomous Agents" | Blog post | 2023 | HIGH |
| 2 | Sumers, Yao et al., "Cognitive Architectures for Language Agents" (CoALA) | Paper (TMLR) | 2023 | HIGH |
| 3 | Zhang et al., "A Survey on the Memory Mechanism of LLM-based Agents" | Paper (arXiv:2404.13501) | 2024 | HIGH |
| 4 | Park et al., "Generative Agents: Interactive Simulacra of Human Behavior" | Paper (UIST 2023) | 2023 | HIGH |
| 5 | Packer et al., "MemGPT: Towards LLMs as Operating Systems" | Paper (arXiv:2310.08560) | 2023 | HIGH |
| 6 | Mem0 — "Building Production-Ready AI Agents with Scalable Long-Term Memory" | Paper + OSS (arXiv:2504.19413) | 2025 | MEDIUM-HIGH |
| 7 | Anthropic, "Prompt Caching" | Official docs | 2025 | HIGH |
| 8 | Anthropic, "Building Effective Agents" | Blog post | 2024 | HIGH |
| 9 | karaxai, "Deep Dive into Claude Code Architecture" | Analysis | 2025 | MEDIUM-HIGH |
| 10 | Latent Space podcast, "Claude Code with Boris Cherny & Cat Wu" | Podcast transcript | 2025 | HIGH |
| 11 | Edge et al., "From Local to Global: A Graph RAG Approach" | Paper (arXiv:2404.16130) | 2024 | MEDIUM |
| 12 | Vinyan codebase analysis | Primary source | 2025 | HIGH |

---

*Research completed: July 2025. Sources span 2023–2025. All claims linked to evidence. No marketing language used.*
