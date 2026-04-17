/**
 * Soul Schema — typed representation of an agent's SOUL.md document.
 *
 * SOUL.md is a living markdown document that IS the agent's identity.
 * Unlike ACL statistics (success rates, episode counts), the soul contains:
 *   - Philosophy: HOW the agent reasons (not labels like "reliable")
 *   - Domain expertise: specific file/module knowledge with evidence
 *   - Winning strategies: approach patterns with causal explanations
 *   - Anti-patterns: what NOT to do, with WHY (causal, not just "failed")
 *   - Self-knowledge: honest limitations backed by data
 *   - Active experiments: hypotheses being tested
 *
 * Design constraints:
 *   - Capped at SOUL_MAX_TOKENS (~1500 tokens) to fit system prompt
 *   - Section limits enforced during rendering
 *   - A1: soul reflects on PROCESS, not output quality
 *   - A3: soul is ADVISORY, never changes routing/governance
 *
 * Source of truth: Living Agent Soul plan
 */

export const SOUL_MAX_TOKENS = 1500;

/** Per-section entry limits to keep soul bounded. */
export const SOUL_SECTION_LIMITS = {
  philosophy: 3,        // lines
  domainExpertise: 5,   // entries
  winningStrategies: 5, // entries
  antiPatterns: 5,      // entries
  selfKnowledge: 3,     // entries
  activeExperiments: 2, // entries
} as const;

export interface DomainEntry {
  area: string;
  files: string[];
  knowledge: string;
  lastEvidence: number; // timestamp
}

export interface StrategyEntry {
  taskPattern: string;
  strategy: string;
  evidenceCount: number;
  lastSuccess: number; // timestamp
}

export interface AntiPatternEntry {
  pattern: string;
  cause: string;
  evidenceCount: number;
  oracleInvolved: string;
}

export interface ExperimentEntry {
  hypothesis: string;
  evidenceFor: number;
  evidenceAgainst: number;
  firstObserved: number; // timestamp
}

export interface SoulDocument {
  agentId: string;
  version: number;
  updatedAt: string; // ISO-8601
  philosophy: string;
  domainExpertise: DomainEntry[];
  winningStrategies: StrategyEntry[];
  antiPatterns: AntiPatternEntry[];
  selfKnowledge: string[];
  activeExperiments: ExperimentEntry[];
}

/** Pending insight from per-task reflection, synthesized into soul during sleep cycle. */
export interface PendingInsight {
  traceId: string;
  timestamp: number;
  category: 'strategy' | 'anti-pattern' | 'domain' | 'self-knowledge' | 'experiment';
  content: string;
  evidence: string;
  confidence: number;
}

/** Rough token estimate: ~1.3 tokens per word. */
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

/** Estimate total tokens for a soul document. */
export function countSoulTokens(soul: SoulDocument): number {
  return estimateTokens(renderSoulMd(soul));
}

/** Create a minimal seed soul for a cold-start agent from its worker tier. */
export function createSeedSoul(agentId: string, tier: string): SoulDocument {
  const philosophyByTier: Record<string, string> = {
    fast: 'I prioritize speed and correctness over exploration. I make focused, minimal changes and avoid over-engineering.',
    balanced: 'I balance thoroughness with efficiency. I read existing patterns before proposing changes and prefer minimal diffs.',
    powerful: 'I handle complex, multi-step tasks with careful analysis. I read the full dependency cone before mutations and verify my reasoning.',
  };

  return {
    agentId,
    version: 0,
    updatedAt: new Date().toISOString(),
    philosophy: philosophyByTier[tier] ?? 'I approach tasks methodically, reading before editing and preferring minimal changes.',
    domainExpertise: [],
    winningStrategies: [],
    antiPatterns: [],
    selfKnowledge: [],
    activeExperiments: [],
  };
}

// ── Markdown parser ─────────────────────────────────────────────────

/** Parse a SOUL.md markdown string into a SoulDocument. */
export function parseSoulMd(raw: string): SoulDocument {
  const lines = raw.split('\n');

  // Extract header metadata
  let agentId = '';
  let version = 0;
  let updatedAt = new Date().toISOString();

  const headerMatch = lines[0]?.match(/^# Soul:\s*(.+)$/);
  if (headerMatch?.[1]) agentId = headerMatch[1].trim();

  const metaMatch = lines[1]?.match(/version:\s*(\d+)\s*\|\s*updated:\s*(.+?)-->/);
  if (metaMatch?.[1] && metaMatch[2]) {
    version = parseInt(metaMatch[1], 10);
    updatedAt = metaMatch[2].trim();
  }

  // Parse sections
  let currentSection = '';
  const sectionContent: Record<string, string[]> = {};

  for (const line of lines) {
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
      sectionContent[currentSection] = [];
      continue;
    }
    // Skip HTML comments and empty lines at section start
    if (line.startsWith('<!--') || (sectionContent[currentSection]?.length === 0 && line.trim() === '')) {
      continue;
    }
    if (currentSection) {
      sectionContent[currentSection]?.push(line);
    }
  }

  return {
    agentId,
    version,
    updatedAt,
    philosophy: (sectionContent['philosophy'] ?? []).join('\n').trim(),
    domainExpertise: parseDomainEntries(sectionContent['domain_expertise'] ?? []),
    winningStrategies: parseStrategyEntries(sectionContent['winning_strategies'] ?? []),
    antiPatterns: parseAntiPatternEntries(sectionContent['anti-patterns'] ?? sectionContent['anti_patterns'] ?? []),
    selfKnowledge: parseListEntries(sectionContent['self-knowledge'] ?? sectionContent['self_knowledge'] ?? []),
    activeExperiments: parseExperimentEntries(sectionContent['active_experiments'] ?? []),
  };
}

function parseDomainEntries(lines: string[]): DomainEntry[] {
  const entries: DomainEntry[] = [];
  for (const line of lines) {
    const match = line.match(/^-\s*(.+?)(?:\(([^)]+)\))?:\s*(.+)$/);
    if (match?.[1] && match[3]) {
      const area = match[1].trim();
      const files = match[2] ? match[2].split(',').map((f) => f.trim()) : [];
      entries.push({ area, files, knowledge: match[3].trim(), lastEvidence: Date.now() });
    }
  }
  return entries.slice(0, SOUL_SECTION_LIMITS.domainExpertise);
}

function parseStrategyEntries(lines: string[]): StrategyEntry[] {
  const entries: StrategyEntry[] = [];
  for (const line of lines) {
    const match = line.match(/^-\s*(?:For\s+)?(.+?):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries.push({
        taskPattern: match[1].trim(),
        strategy: match[2].trim(),
        evidenceCount: 0,
        lastSuccess: Date.now(),
      });
    }
  }
  return entries.slice(0, SOUL_SECTION_LIMITS.winningStrategies);
}

function parseAntiPatternEntries(lines: string[]): AntiPatternEntry[] {
  const entries: AntiPatternEntry[] = [];
  let current: Partial<AntiPatternEntry> | null = null;

  for (const line of lines) {
    const mainMatch = line.match(/^-\s*(.+)$/);
    if (mainMatch?.[1] && !line.match(/^\s+\(/)) {
      if (current?.pattern) entries.push(current as AntiPatternEntry);
      current = { pattern: mainMatch[1].trim(), cause: '', evidenceCount: 0, oracleInvolved: '' };
      continue;
    }
    const causeMatch = line.match(/^\s+\(Caused:\s*(.+)\)$/);
    if (causeMatch?.[1] && current) {
      current.cause = causeMatch[1].trim();
      const oracleMatch = current.cause.match(/oracle:\s*(\w+)/);
      if (oracleMatch?.[1]) current.oracleInvolved = oracleMatch[1];
      const countMatch = current.cause.match(/(\d+)\s+(?:hallucination|failure)/);
      if (countMatch?.[1]) current.evidenceCount = parseInt(countMatch[1], 10);
    }
  }
  if (current?.pattern) entries.push(current as AntiPatternEntry);

  return entries.slice(0, SOUL_SECTION_LIMITS.antiPatterns);
}

function parseListEntries(lines: string[]): string[] {
  return lines
    .filter((l) => l.match(/^-\s+/))
    .map((l) => l.replace(/^-\s+/, '').trim())
    .slice(0, SOUL_SECTION_LIMITS.selfKnowledge);
}

function parseExperimentEntries(lines: string[]): ExperimentEntry[] {
  const entries: ExperimentEntry[] = [];
  let current: Partial<ExperimentEntry> | null = null;

  for (const line of lines) {
    const hypMatch = line.match(/^-\s*(?:Hypothesis:\s*)?(.+)$/);
    if (hypMatch?.[1] && !line.match(/^\s+\(/)) {
      if (current?.hypothesis) entries.push(current as ExperimentEntry);
      current = { hypothesis: hypMatch[1].trim(), evidenceFor: 0, evidenceAgainst: 0, firstObserved: Date.now() };
      continue;
    }
    const evidenceMatch = line.match(/(\d+)\/(\d+)\s+(?:with|successes?)/);
    if (evidenceMatch?.[1] && evidenceMatch[2] && current) {
      current.evidenceFor = parseInt(evidenceMatch[1], 10);
      const total = parseInt(evidenceMatch[2], 10);
      current.evidenceAgainst = total - current.evidenceFor;
    }
  }
  if (current?.hypothesis) entries.push(current as ExperimentEntry);

  return entries.slice(0, SOUL_SECTION_LIMITS.activeExperiments);
}

// ── Markdown renderer ───────────────────────────────────────────────

/** Render a SoulDocument into a SOUL.md markdown string. */
export function renderSoulMd(soul: SoulDocument): string {
  const lines: string[] = [];

  lines.push(`# Soul: ${soul.agentId}`);
  lines.push(`<!-- version: ${soul.version} | updated: ${soul.updatedAt} -->`);
  lines.push('');

  // Philosophy
  lines.push('## Philosophy');
  if (soul.philosophy) {
    lines.push(soul.philosophy);
  }
  lines.push('');

  // Domain Expertise
  if (soul.domainExpertise.length > 0) {
    lines.push('## Domain Expertise');
    for (const entry of soul.domainExpertise.slice(0, SOUL_SECTION_LIMITS.domainExpertise)) {
      const filesStr = entry.files.length > 0 ? ` (${entry.files.join(', ')})` : '';
      lines.push(`- ${entry.area}${filesStr}: ${entry.knowledge}`);
    }
    lines.push('');
  }

  // Winning Strategies
  if (soul.winningStrategies.length > 0) {
    lines.push('## Winning Strategies');
    for (const entry of soul.winningStrategies.slice(0, SOUL_SECTION_LIMITS.winningStrategies)) {
      lines.push(`- ${entry.taskPattern}: ${entry.strategy}`);
    }
    lines.push('');
  }

  // Anti-Patterns
  if (soul.antiPatterns.length > 0) {
    lines.push('## Anti-Patterns');
    for (const entry of soul.antiPatterns.slice(0, SOUL_SECTION_LIMITS.antiPatterns)) {
      lines.push(`- ${entry.pattern}`);
      if (entry.cause) {
        lines.push(`  (Caused: ${entry.cause})`);
      }
    }
    lines.push('');
  }

  // Self-Knowledge
  if (soul.selfKnowledge.length > 0) {
    lines.push('## Self-Knowledge');
    for (const entry of soul.selfKnowledge.slice(0, SOUL_SECTION_LIMITS.selfKnowledge)) {
      lines.push(`- ${entry}`);
    }
    lines.push('');
  }

  // Active Experiments
  if (soul.activeExperiments.length > 0) {
    lines.push('## Active Experiments');
    for (const entry of soul.activeExperiments.slice(0, SOUL_SECTION_LIMITS.activeExperiments)) {
      const total = entry.evidenceFor + entry.evidenceAgainst;
      lines.push(`- ${entry.hypothesis}`);
      lines.push(`  (${entry.evidenceFor}/${total} successes — ${total < 10 ? 'needs more data' : 'sufficient data'})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
