/**
 * Tests for the CorrectionDetector — the rule-based half of the A7 loop.
 */

import { describe, expect, test } from 'bun:test';
import { detectCorrection } from '../../../../src/orchestrator/comprehension/learning/correction-detector.ts';
import type { ComprehensionRecordRow } from '../../../../src/db/comprehension-store.ts';

function priorRecord(overrides: Partial<ComprehensionRecordRow> = {}): ComprehensionRecordRow {
  return {
    input_hash: 'h1',
    task_id: 't-1',
    session_id: 's-1',
    engine_id: 'rule-comprehender',
    engine_type: 'rule',
    tier: 'deterministic',
    type: 'comprehension',
    confidence: 1,
    verdict_pass: 1,
    verdict_reason: null,
    envelope_json: '{}',
    created_at: Date.now(),
    outcome: null,
    outcome_evidence: null,
    outcome_at: null,
    ...overrides,
  };
}

describe('CorrectionDetector', () => {
  test('returns null when no prior record exists', () => {
    const verdict = detectCorrection({
      priorRecord: null,
      currentUserMessage: 'anything',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(verdict).toBeNull();
  });

  test('returns null when prior record already has an outcome', () => {
    const verdict = detectCorrection({
      priorRecord: priorRecord({ outcome: 'confirmed' }),
      currentUserMessage: 'ok',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(verdict).toBeNull();
  });

  test('clarification-answer always confirms prior comprehension', () => {
    const verdict = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'no — romance style',
      currentIsClarificationAnswer: true,
      currentIsNewTopic: false,
    });
    // Even though the reply opens with "no", the turn is structurally a
    // clarification answer → confirms the thread.
    expect(verdict?.outcome).toBe('confirmed');
    expect(verdict?.evidence.reason).toBe('clarification-answer');
  });

  test('English opening correction tokens → corrected', () => {
    for (const msg of [
      'no, that is wrong',
      'not that one',
      'actually, I meant the other helper',
      'wait, I want the utils file',
      "that's not what I asked for",
      'change that to use promises',
      'undo last step',
    ]) {
      const v = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: msg,
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(v?.outcome).toBe('corrected');
      expect(v?.evidence.reason).toBe('correction-token');
    }
  });

  test('Thai opening correction tokens → corrected', () => {
    for (const msg of [
      'ไม่ใช่ ฉันหมายถึงอีกอันหนึ่ง',
      'ผิด ต้องเปลี่ยนใหม่',
      'ไม่ได้ ลองอีกที',
      'แก้เป็น x แทน',
      'เปลี่ยนให้เป็น y',
    ]) {
      const v = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: msg,
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(v?.outcome).toBe('corrected');
    }
  });

  test('embedded negation ("not that", "ไม่อยาก") → corrected', () => {
    const v1 = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'I really do not want that approach',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(v1?.outcome).toBe('corrected');

    const v2 = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'ใช้ method อื่นดีกว่า ไม่อยากใช้ promise',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(v2?.outcome).toBe('corrected');
  });

  test('new topic → abandoned', () => {
    const v = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'Write me a completely different function',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: true,
    });
    expect(v?.outcome).toBe('abandoned');
    expect(v?.evidence.reason).toBe('new-topic');
  });

  test('normal continuation (no correction tokens, not a new topic) → confirmed', () => {
    const v = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'now also add error handling for the edge case',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(v?.outcome).toBe('confirmed');
    expect(v?.evidence.reason).toBe('continuation');
  });

  test('opening token matching is position-sensitive', () => {
    // "no" buried inside a long reply is NOT a correction.
    const v = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'please add validation so we have no null pointer issues',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(v?.outcome).toBe('confirmed');
  });

  test('single-word "no" at opening still corrects', () => {
    const v = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'No let me rethink',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(v?.outcome).toBe('corrected');
  });

  test('correction token OVERRIDES new-topic flag', () => {
    // When a correction is loud-and-clear, treat it as corrected even if
    // the comprehender also flagged new-topic — the user is specifically
    // correcting the prior goal, not abandoning it silently.
    const v = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'actually, change the whole approach',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: true,
    });
    expect(v?.outcome).toBe('corrected');
  });

  test('evidence is JSON-serializable', () => {
    const v = detectCorrection({
      priorRecord: priorRecord(),
      currentUserMessage: 'actually wait',
      currentIsClarificationAnswer: false,
      currentIsNewTopic: false,
    });
    expect(() => JSON.stringify(v?.evidence)).not.toThrow();
  });

  // ── AXM#5: per-rule label confidence ────────────────────────────────
  describe('evidence.confidence reflects rule strength', () => {
    test('explicit correction token → confidence 1', () => {
      const v = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'no, not that',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(v?.evidence.confidence).toBe(1);
    });

    test('clarification-answer → confidence 1', () => {
      const v = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'anything',
        currentIsClarificationAnswer: true,
        currentIsNewTopic: false,
      });
      expect(v?.evidence.confidence).toBe(1);
    });

    test('embedded negation → confidence 0.9', () => {
      const v = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'I do not want that approach',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(v?.evidence.confidence).toBe(0.9);
    });

    test('new-topic → confidence 0.7', () => {
      const v = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'Write a completely different thing',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: true,
      });
      expect(v?.evidence.confidence).toBe(0.7);
    });

    test('continuation default → confidence 0.5 (weakest claim)', () => {
      const v = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'thanks',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      });
      expect(v?.outcome).toBe('confirmed');
      expect(v?.evidence.confidence).toBe(0.5);
    });

    test('confidence is monotonically non-increasing across rule precedence', () => {
      // Verify the taxonomy: explicit > embedded > new-topic > continuation.
      const explicit = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'no, wrong',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      })!.evidence.confidence;
      const embedded = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'do not want that',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      })!.evidence.confidence;
      const newTopic = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'unrelated thing',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: true,
      })!.evidence.confidence;
      const contin = detectCorrection({
        priorRecord: priorRecord(),
        currentUserMessage: 'thanks',
        currentIsClarificationAnswer: false,
        currentIsNewTopic: false,
      })!.evidence.confidence;
      expect(explicit).toBeGreaterThanOrEqual(embedded);
      expect(embedded).toBeGreaterThanOrEqual(newTopic);
      expect(newTopic).toBeGreaterThanOrEqual(contin);
    });
  });
});
