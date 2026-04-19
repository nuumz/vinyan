/**
 * Tests for the pipeline-vs-user constraint partitioner.
 *
 * Locks the invariant: every prompt-building call site (decomposer,
 * replanner, workflow planner, intent classifier) should render ONLY
 * user-facing constraints to its LLM, never orchestrator-internal
 * prefixes like COMPREHENSION_SUMMARY: or CLARIFIED:.
 */

import { describe, expect, test } from 'bun:test';
import {
  PIPELINE_CONSTRAINT_PREFIXES,
  PIPELINE_CONSTRAINT_TOKENS,
  isPipelineConstraint,
  partitionConstraints,
  userConstraintsOnly,
} from '../../../src/orchestrator/constraints/pipeline-constraints.ts';

describe('partitionConstraints', () => {
  test('empty / null / undefined yield empty halves', () => {
    expect(partitionConstraints(undefined)).toEqual({ user: [], pipeline: [] });
    expect(partitionConstraints(null)).toEqual({ user: [], pipeline: [] });
    expect(partitionConstraints([])).toEqual({ user: [], pipeline: [] });
  });

  test('all user-facing entries end up in .user', () => {
    const out = partitionConstraints([
      'must use the existing logger',
      'no new dependencies',
      'respect line length 120',
    ]);
    expect(out.user).toEqual([
      'must use the existing logger',
      'no new dependencies',
      'respect line length 120',
    ]);
    expect(out.pipeline).toEqual([]);
  });

  test('CLARIFIED: routes to pipeline', () => {
    const out = partitionConstraints(['CLARIFIED:Which module?=>auth']);
    expect(out.pipeline).toEqual(['CLARIFIED:Which module?=>auth']);
    expect(out.user).toEqual([]);
  });

  test('COMPREHENSION_SUMMARY: routes to pipeline', () => {
    const entry = 'COMPREHENSION_SUMMARY:{"rootGoal":"write poem","isClarificationAnswer":true}';
    const out = partitionConstraints([entry]);
    expect(out.pipeline).toEqual([entry]);
    expect(out.user).toEqual([]);
  });

  test('CLARIFICATION_BATCH: routes to pipeline', () => {
    const entry = 'CLARIFICATION_BATCH:{"questions":["a?"],"reply":"yes"}';
    const out = partitionConstraints([entry]);
    expect(out.pipeline).toEqual([entry]);
  });

  test('MIN_ROUTING_LEVEL: routes to pipeline', () => {
    const out = partitionConstraints(['MIN_ROUTING_LEVEL:2']);
    expect(out.pipeline).toEqual(['MIN_ROUTING_LEVEL:2']);
  });

  test('bare tokens (THINKING:enabled / TOOLS:enabled) route to pipeline', () => {
    const out = partitionConstraints(['THINKING:enabled', 'TOOLS:enabled']);
    expect(out.pipeline).toEqual(['THINKING:enabled', 'TOOLS:enabled']);
    expect(out.user).toEqual([]);
  });

  test('mixed entries preserve input order within each half', () => {
    const out = partitionConstraints([
      'user rule A',
      'MIN_ROUTING_LEVEL:1',
      'user rule B',
      'COMPREHENSION_SUMMARY:{}',
      'user rule C',
      'CLARIFIED:q=>a',
    ]);
    expect(out.user).toEqual(['user rule A', 'user rule B', 'user rule C']);
    expect(out.pipeline).toEqual([
      'MIN_ROUTING_LEVEL:1',
      'COMPREHENSION_SUMMARY:{}',
      'CLARIFIED:q=>a',
    ]);
  });

  test('case-sensitive: lowercase prefixes stay in user', () => {
    // The prefixes are SCREAMING_CASE by convention; a lowercase version is
    // almost certainly user prose and should pass through.
    const out = partitionConstraints(['clarified: ignore case']);
    expect(out.user).toEqual(['clarified: ignore case']);
    expect(out.pipeline).toEqual([]);
  });
});

describe('isPipelineConstraint', () => {
  test('every registered prefix is recognized', () => {
    for (const prefix of PIPELINE_CONSTRAINT_PREFIXES) {
      expect(isPipelineConstraint(`${prefix}payload`)).toBe(true);
    }
  });
  test('every registered token is recognized', () => {
    for (const token of PIPELINE_CONSTRAINT_TOKENS) {
      expect(isPipelineConstraint(token)).toBe(true);
    }
  });
  test('arbitrary user text is not recognized', () => {
    expect(isPipelineConstraint('respect line length')).toBe(false);
    expect(isPipelineConstraint('use the logger helper')).toBe(false);
  });
});

describe('userConstraintsOnly', () => {
  test('returns a fresh array containing only user entries', () => {
    const out = userConstraintsOnly([
      'a',
      'CLARIFIED:q=>yes',
      'b',
      'THINKING:enabled',
    ]);
    expect(out).toEqual(['a', 'b']);
  });
});
