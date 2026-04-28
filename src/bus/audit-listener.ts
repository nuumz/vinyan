/**
 * Audit Listener — appends structured JSONL for all bus events.
 *
 * Best-effort file writes (swallows errors). Provides event-sourced audit trail
 * for post-mortem debugging and future Sleep Cycle queries.
 *
 * Source of truth: spec/tdd.md §1C.4
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { BusEventName, VinyanBus } from '../core/bus.ts';

const ALL_EVENTS: BusEventName[] = [
  'task:start',
  'task:complete',
  'worker:dispatch',
  'worker:complete',
  'worker:error',
  'oracle:verdict',
  'trace:record',
  'trace:write_failed',
  'selfmodel:predict',
  // Forward Predictor (A7)
  'prediction:generated',
  'prediction:calibration',
  'prediction:outcome-skipped',
  'graph:fact',
  'circuit:open',
  'circuit:close',
  'task:escalate',
  'task:timeout',
  'task:explore',
  'shadow:enqueue',
  'shadow:complete',
  'shadow:failed',
  'skill:match',
  'skill:miss',
  'skill:outcome',
  'evolution:rulesApplied',
  'evolution:rulePromoted',
  'evolution:ruleRetired',
  'evolution:capabilityPromoted',
  'sleep:cycleComplete',
  'tools:executed',
  // Phase 1 — verification & governance
  'critic:verdict',
  'task:approval_required',
  'commit:rejected',
  // Guardrails
  'guardrail:injection_detected',
  'guardrail:bypass_detected',
  // K1.5: Security violation (block-not-strip)
  'security:injection_detected',
  // K1.1: Contradiction escalation
  'verification:contradiction_escalated',
  'verification:contradiction_unresolved',
  // Self-model & oracle
  'selfmodel:calibration_error',
  'oracle:contradiction',
  'oracle:self_report_excluded',
  'agent:tool_denied',
  // Decomposer
  'decomposer:fallback',
  'degradation:triggered',
  // Phase 4 — Fleet Governance
  'worker:selected',
  'worker:exploration',
  'fleet:convergence_warning',
  'fleet:emergency_reactivation',
  'fleet:diversity_enforced',
  // Unified AgentProfile lifecycle — kind-tagged: worker | oracle-peer | oracle-local
  'profile:registered',
  'profile:promoted',
  'profile:demoted',
  'profile:reactivated',
  'profile:retired',
  'task:uncertain',
  // Phase 4 — additional
  'guardrail:violation',
  'oracle:deliberation_request',
  // Phase 5 — Observability
  'memory:eviction_warning',
  'context:verdict_omitted',
  'selfmodel:systematic_miscalibration',
  'observability:alert',
  // Phase 5 — API & Session
  'api:request',
  'api:response',
  'session:created',
  'session:compacted',
  // Phase 5 — File & Peer
  'file:hashChanged',
  'peer:connected',
  'peer:disconnected',
  'peer:trustChanged',
  // Phase 5 — A2A Knowledge
  'a2a:verdictReceived',
  'a2a:knowledgeImported',
  'a2a:knowledgeOffered',
  'a2a:knowledgeAccepted',
  // Phase 5 — A2A Coordination
  'a2a:proposalReceived',
  'a2a:commitmentFailed',
  'a2a:retractionReceived',
  'a2a:feedbackReceived',
  'a2a:intentDeclared',
  'a2a:intentConflict',
  'a2a:capabilityUpdated',
];

export function attachAuditListener(bus: VinyanBus, auditPath: string): () => void {
  // Ensure parent directory exists
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
  } catch {
    // Best-effort
  }

  const detachers: Array<() => void> = [];

  for (const event of ALL_EVENTS) {
    detachers.push(
      bus.on(event, (payload: unknown) => {
        try {
          const line = JSON.stringify({ ts: Date.now(), event, payload });
          appendFileSync(auditPath, `${line}\n`);
        } catch {
          // Audit is best-effort — never block the core loop
        }
      }),
    );
  }

  return () => {
    for (const detach of detachers) detach();
  };
}
