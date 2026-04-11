import { describe, expect, test } from 'bun:test';
import { getEventStyle, isDefaultVisible, mapBusEvent, summarizeEvent } from '../../src/tui/data/event-mapper.ts';

describe('getEventStyle', () => {
  test('returns correct style for known events', () => {
    const style = getEventStyle('task:start');
    expect(style.domain).toBe('task');
    expect(style.defaultVisible).toBe(true);

    const oracle = getEventStyle('oracle:verdict');
    expect(oracle.domain).toBe('oracle');
    expect(oracle.defaultVisible).toBe(false);

    const guard = getEventStyle('guardrail:injection_detected');
    expect(guard.domain).toBe('guard');
    expect(guard.defaultVisible).toBe(true);
  });

  test('returns default style for unknown events', () => {
    const style = getEventStyle('unknown:event');
    expect(style.domain).toBe('other');
    expect(style.defaultVisible).toBe(false);
  });
});

describe('isDefaultVisible', () => {
  test('task:start is visible by default', () => {
    expect(isDefaultVisible('task:start')).toBe(true);
  });

  test('api:request is hidden by default', () => {
    expect(isDefaultVisible('api:request')).toBe(false);
  });

  test('guardrail events are always visible', () => {
    expect(isDefaultVisible('guardrail:injection_detected')).toBe(true);
    expect(isDefaultVisible('guardrail:bypass_detected')).toBe(true);
    expect(isDefaultVisible('guardrail:violation')).toBe(true);
  });

  test('peer events are visible', () => {
    expect(isDefaultVisible('peer:connected')).toBe(true);
    expect(isDefaultVisible('peer:disconnected')).toBe(true);
  });
});

describe('summarizeEvent', () => {
  test('task:start shows routing level and goal', () => {
    const summary = summarizeEvent('task:start', {
      input: { goal: 'Fix bug in parser' },
      routing: { level: 2 },
    });
    expect(summary).toContain('L2');
    expect(summary).toContain('Fix bug in parser');
  });

  test('oracle:verdict shows oracle name and pass/fail', () => {
    const summary = summarizeEvent('oracle:verdict', {
      oracleName: 'ast',
      verdict: { verified: true, confidence: 0.95 },
    });
    expect(summary).toContain('ast');
    expect(summary).toContain('PASS');
    expect(summary).toContain('0.95');
  });

  test('oracle:verdict shows FAIL for rejected', () => {
    const summary = summarizeEvent('oracle:verdict', {
      oracleName: 'type',
      verdict: { verified: false, confidence: 0.8 },
    });
    expect(summary).toContain('FAIL');
  });

  test('sleep:cycleComplete shows counts', () => {
    const summary = summarizeEvent('sleep:cycleComplete', {
      patternsFound: 5,
      rulesGenerated: 2,
      skillsCreated: 1,
    });
    expect(summary).toContain('patterns=5');
    expect(summary).toContain('rules=2');
  });

  test('peer:connected shows peer ID and URL', () => {
    const summary = summarizeEvent('peer:connected', {
      peerId: 'inst-02',
      url: 'https://staging:3928',
    });
    expect(summary).toContain('inst-02');
    expect(summary).toContain('https://staging:3928');
  });

  test('unknown event falls back to truncated JSON', () => {
    const summary = summarizeEvent('some:unknown', { key: 'value' });
    expect(summary).toContain('key');
  });
});

describe('mapBusEvent', () => {
  test('creates EventLogEntry with correct fields', () => {
    const entry = mapBusEvent('task:complete', {
      result: { status: 'completed', qualityScore: { composite: 0.85 } },
    });
    expect(entry.domain).toBe('task');
    expect(entry.event).toBe('task:complete');
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.summary).toContain('completed');
    expect(entry.icon).toBeTruthy();
    expect(entry.colorCode).toBeTruthy();
  });
});
