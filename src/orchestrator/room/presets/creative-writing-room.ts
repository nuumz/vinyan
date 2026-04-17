/**
 * Creative-Writing Room Preset — the role composition for long-form creative
 * tasks (novels, webtoons, articles, screenplays).
 *
 * Roles:
 *   - writer: drafts content into `writer:draft:*` scope.
 *   - editor: reviews + suggests revisions into `editor:feedback:*`.
 *   - trend-analyst: validates genre / audience fit into `analyst:validation:*`.
 *
 * The preset is pure data — downstream Room dispatch code takes it, assigns
 * workers to each role, and runs the Supervisor FSM. Because the preset is
 * deterministic, A3 (deterministic governance) is preserved.
 */

import type { RoleSpec, RoomContract } from '../types.ts';

const WRITER_ROLE: RoleSpec = {
  name: 'writer',
  responsibility:
    'Draft the requested creative content (story outline, scene, chapter, script page) based on the brief and any trend-analyst validation. Write into `writer:draft:*`.',
  writableBlackboardKeys: ['writer:draft:*', 'shared:outline'],
  maxTurns: 2,
  canWriteFiles: true,
};

const EDITOR_ROLE: RoleSpec = {
  name: 'editor',
  responsibility:
    'Review the writer\'s draft for narrative coherence, pacing, character voice, and grammar. Post constructive feedback into `editor:feedback:*`. Do NOT rewrite — propose edits; the writer applies them.',
  writableBlackboardKeys: ['editor:feedback:*'],
  maxTurns: 2,
  canWriteFiles: false,
};

const TREND_ANALYST_ROLE: RoleSpec = {
  name: 'trend-analyst',
  responsibility:
    'Validate the proposed genre / audience fit against current trends (from the research step). Flag if the premise is oversaturated, miss-targeted, or missing a commercial hook. Write into `analyst:validation:*`.',
  writableBlackboardKeys: ['analyst:validation:*'],
  maxTurns: 1,
  canWriteFiles: false,
};

export const CREATIVE_WRITING_ROLES: RoleSpec[] = [
  WRITER_ROLE,
  EDITOR_ROLE,
  TREND_ANALYST_ROLE,
];

export interface CreativeWritingRoomOptions {
  roomId: string;
  parentTaskId: string;
  goal: string;
  tokenBudget: number;
  /** Override convergence threshold (default 0.75 — slightly stricter than the generic room default). */
  convergenceThreshold?: number;
}

/**
 * Build a RoomContract pre-configured for creative-writing collaboration.
 * Returns a contract the Room dispatcher can use directly.
 */
export function buildCreativeWritingRoomContract(
  options: CreativeWritingRoomOptions,
): RoomContract {
  return {
    roomId: options.roomId,
    parentTaskId: options.parentTaskId,
    goal: options.goal,
    roles: CREATIVE_WRITING_ROLES,
    maxRounds: 3,
    minRounds: 1,
    convergenceThreshold: options.convergenceThreshold ?? 0.75,
    tokenBudget: options.tokenBudget,
  };
}

/**
 * Heuristic: decide whether a goal should use the creative-writing room.
 * Intentionally conservative — we only fire on explicit creative deliverable
 * verbs + object nouns to avoid wasting room budget on short tasks.
 */
const CREATIVE_ROOM_TRIGGER_REGEX =
  /(เขียน|แต่ง|ร่าง|ประพันธ์|ผลิต|เรียบเรียง|write|compose|draft|author|craft)[^.?!]{0,60}(นิยาย|เรื่องสั้น|เว็บตูน|การ์ตูน|บทความ|คอนเทนต์|โพสต์|บท|novel|story|webtoon|article|screenplay|blog ?post|essay|chapter|script|newsletter)/iu;

export function shouldUseCreativeWritingRoom(goal: string): boolean {
  if (goal.trim().length < 10) return false;
  return CREATIVE_ROOM_TRIGGER_REGEX.test(goal);
}
