/**
 * Conformance test suite runner — validates an oracle verdict against all applicable levels.
 */

import { validateLevel0 } from './level0.ts';
import { validateLevel1, validateJsonRpcEnvelope } from './level1.ts';
import { validateLevel2, validateVersionHandshake, validateVersionResponse } from './level2.ts';
import { validateLevel3 } from './level3.ts';

export type ConformanceLevel = 0 | 1 | 2 | 3;

export interface ConformanceResult {
  /** Target conformance level. */
  targetLevel: ConformanceLevel;
  /** Highest level fully passed. */
  achievedLevel: ConformanceLevel | -1;
  /** Results per level attempted. */
  levels: Array<{
    level: ConformanceLevel;
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; error?: string }>;
  }>;
}

/**
 * Run conformance suite up to the specified target level.
 *
 * Each level includes all checks from lower levels. If a lower level fails,
 * higher levels are not attempted.
 */
export function runConformanceSuite(verdictJson: string, targetLevel: ConformanceLevel = 2): ConformanceResult {
  const levels: ConformanceResult['levels'] = [];
  let achievedLevel: ConformanceLevel | -1 = -1;

  // Level 0 — always run
  const l0 = validateLevel0(verdictJson);
  levels.push({ level: 0, passed: l0.passed, checks: l0.checks });
  if (l0.passed) achievedLevel = 0;

  if (!l0.passed || targetLevel === 0) {
    return { targetLevel, achievedLevel, levels };
  }

  // Level 1
  const l1 = validateLevel1(verdictJson);
  levels.push({ level: 1, passed: l1.passed, checks: l1.checks });
  if (l1.passed) achievedLevel = 1;

  if (!l1.passed || targetLevel === 1) {
    return { targetLevel, achievedLevel, levels };
  }

  // Level 2
  const l2 = validateLevel2(verdictJson);
  levels.push({ level: 2, passed: l2.passed, checks: l2.checks });
  if (l2.passed) achievedLevel = 2;

  if (!l2.passed || targetLevel === 2) {
    return { targetLevel, achievedLevel, levels };
  }

  // Level 3
  const l3 = validateLevel3(verdictJson);
  levels.push({ level: 3, passed: l3.passed, checks: l3.checks });
  if (l3.passed) achievedLevel = 3;

  return { targetLevel, achievedLevel, levels };
}
