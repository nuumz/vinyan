/**
 * Tests for soul-schema.ts — SOUL.md parsing, rendering, and token counting.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseSoulMd,
  renderSoulMd,
  createSeedSoul,
  countSoulTokens,
  SOUL_MAX_TOKENS,
} from '../../../src/orchestrator/agent-context/soul-schema.ts';

const SAMPLE_SOUL_MD = `# Soul: worker-fast-01
<!-- version: 3 | updated: 2026-04-17T03:14:00Z -->

## Philosophy
I read the full dependency cone before proposing mutations.
When uncertain, I search for prior art in the codebase.

## Domain Expertise
- auth module (src/security/auth.ts): JWT validation flow, middleware chain
- oracle integration: ast oracle needs symbol existence, type oracle = tsc --noEmit

## Winning Strategies
- refactoring: extract-method with inline tests, verify via ast+type oracles
- bug fixes: reproduce via test first, then fix

## Anti-Patterns
- NEVER guess import paths — always verify via file_read first
  (Caused: 3 hallucination failures, oracle: ast)
- NEVER refactor unrelated code in bug-fix tasks
  (Caused: 2 failures where lint oracle caught formatting changes)

## Self-Knowledge
- I tend to over-engineer simple tasks
- My Python code quality is below average

## Active Experiments
- Reading test files before implementation may improve success
  (3/4 successes — needs more data)
`;

describe('Soul Schema', () => {
  test('parseSoulMd extracts header metadata', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    expect(soul.agentId).toBe('worker-fast-01');
    expect(soul.version).toBe(3);
    expect(soul.updatedAt).toContain('2026-04-17');
  });

  test('parseSoulMd extracts philosophy', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    expect(soul.philosophy).toContain('dependency cone');
    expect(soul.philosophy).toContain('prior art');
  });

  test('parseSoulMd extracts domain expertise', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    expect(soul.domainExpertise).toHaveLength(2);
    expect(soul.domainExpertise[0]!.area).toContain('auth module');
    expect(soul.domainExpertise[0]!.knowledge).toContain('JWT');
  });

  test('parseSoulMd extracts winning strategies', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    expect(soul.winningStrategies).toHaveLength(2);
    expect(soul.winningStrategies[0]!.taskPattern).toContain('refactoring');
    expect(soul.winningStrategies[0]!.strategy).toContain('extract-method');
  });

  test('parseSoulMd extracts anti-patterns with cause', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    expect(soul.antiPatterns.length).toBeGreaterThanOrEqual(1);
    expect(soul.antiPatterns[0]!.pattern).toContain('guess import paths');
    expect(soul.antiPatterns[0]!.oracleInvolved).toBe('ast');
    expect(soul.antiPatterns[0]!.evidenceCount).toBe(3);
  });

  test('parseSoulMd extracts self-knowledge', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    expect(soul.selfKnowledge).toHaveLength(2);
    expect(soul.selfKnowledge[0]).toContain('over-engineer');
  });

  test('parseSoulMd extracts active experiments', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    expect(soul.activeExperiments.length).toBeGreaterThanOrEqual(1);
    expect(soul.activeExperiments[0]!.hypothesis).toContain('test files');
  });

  test('renderSoulMd produces valid markdown', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    const rendered = renderSoulMd(soul);
    expect(rendered).toContain('# Soul: worker-fast-01');
    expect(rendered).toContain('## Philosophy');
    expect(rendered).toContain('## Domain Expertise');
    expect(rendered).toContain('## Winning Strategies');
    expect(rendered).toContain('## Anti-Patterns');
    expect(rendered).toContain('## Self-Knowledge');
  });

  test('parse → render roundtrip preserves key data', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    const rendered = renderSoulMd(soul);
    const reparsed = parseSoulMd(rendered);

    expect(reparsed.agentId).toBe(soul.agentId);
    expect(reparsed.philosophy).toBe(soul.philosophy);
    expect(reparsed.domainExpertise).toHaveLength(soul.domainExpertise.length);
    expect(reparsed.winningStrategies).toHaveLength(soul.winningStrategies.length);
    expect(reparsed.selfKnowledge).toHaveLength(soul.selfKnowledge.length);
  });

  test('createSeedSoul generates valid soul for each tier', () => {
    for (const tier of ['fast', 'balanced', 'powerful']) {
      const soul = createSeedSoul(`worker-${tier}-01`, tier);
      expect(soul.agentId).toBe(`worker-${tier}-01`);
      expect(soul.philosophy.length).toBeGreaterThan(0);
      expect(soul.version).toBe(0);
      expect(soul.domainExpertise).toHaveLength(0);
    }
  });

  test('countSoulTokens stays within budget', () => {
    const soul = parseSoulMd(SAMPLE_SOUL_MD);
    const tokens = countSoulTokens(soul);
    expect(tokens).toBeLessThanOrEqual(SOUL_MAX_TOKENS);
    expect(tokens).toBeGreaterThan(0);
  });

  test('empty soul parses without error', () => {
    const soul = parseSoulMd('# Soul: empty\n<!-- version: 0 | updated: now -->\n');
    expect(soul.agentId).toBe('empty');
    expect(soul.philosophy).toBe('');
    expect(soul.domainExpertise).toHaveLength(0);
  });
});
