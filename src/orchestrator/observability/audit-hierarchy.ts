/**
 * Audit-hierarchy helper — derive the `{ sessionId, subTaskId, subAgentId }`
 * wrapper fields from a TaskInput at every emit site.
 *
 * Today's invariants:
 *   - Root task: `parentTaskId` absent ⇒ no `subTaskId` / `subAgentId`.
 *   - Sub-task: `parentTaskId` present ⇒ `subTaskId === input.id` AND
 *     `subAgentId === input.id` (the sub-agent owns one sub-task).
 *   - `sessionId` rides through every level via `input.sessionId`. The
 *     task-event recorder cache backfills if absent (`task-event-recorder`).
 *
 * Centralised so a future move to a non-1:1 sub-agent ↔ sub-task scheme
 * is one edit. All audit emit sites in `core-loop`, `phase-verify`,
 * `orchestration-boundaries`, `agent-loop`, and the workflow path call
 * through here.
 */
import type { TaskInput } from '../types.ts';

export interface AuditHierarchyProps {
  sessionId?: string;
  subTaskId?: string;
  subAgentId?: string;
}

export function hierarchyFromInput(input: TaskInput): AuditHierarchyProps {
  const out: AuditHierarchyProps = {};
  if (input.sessionId) out.sessionId = input.sessionId;
  if (input.parentTaskId) {
    // 1:1 invariant: subAgent identity == subTask identity == this input's id
    out.subTaskId = input.id;
    out.subAgentId = input.id;
  }
  return out;
}
