/**
 * AgentContextUpdater — post-task learning for agent context.
 *
 * Called in the LEARN phase after oracle verification to record episodes,
 * update skill proficiencies, and track approach preferences/anti-patterns.
 *
 * All updates are best-effort (A3: never blocks trace recording).
 *
 * Source of truth: ultraplan — Agent Contextual Redesign, Phase 5
 */
import type { AgentContextStore } from '../../db/agent-context-store.ts';
import type { CapabilityModel } from '../fleet/capability-model.ts';
import type { ExecutionTrace } from '../types.ts';
import type { SoulReflector } from './soul-reflector.ts';
import { type AgentContext, type AgentEpisode, type EpisodeOutcome, MAX_EPISODES, type SkillLevel } from './types.ts';

export interface AgentContextUpdaterDeps {
  agentContextStore: AgentContextStore;
  capabilityModel?: CapabilityModel;
  /** Living Agent Soul: LLM-powered reflection engine (optional, best-effort). */
  soulReflector?: SoulReflector;
}

export class AgentContextUpdater {
  private store: AgentContextStore;
  private capabilityModel?: CapabilityModel;
  private soulReflector?: SoulReflector;

  constructor(deps: AgentContextUpdaterDeps) {
    this.store = deps.agentContextStore;
    this.capabilityModel = deps.capabilityModel;
    this.soulReflector = deps.soulReflector;
  }

  /**
   * Update agent context after a completed task.
   * Best-effort — never throws.
   */
  updateAfterTask(agentId: string, trace: ExecutionTrace): void {
    try {
      const context = this.store.findOrCreate(agentId);

      // 1. Record episode
      const episode = this.extractEpisode(trace);
      this.addEpisode(context, episode);

      // 2. Update skill proficiency
      if (trace.taskTypeSignature) {
        this.updateProficiency(context, trace);
      }

      // 3. Record preferred approach if successful
      if (trace.outcome === 'success' && trace.taskTypeSignature && trace.approach) {
        context.skills.preferredApproaches[trace.taskTypeSignature] = trace.approach;
      }

      // 4. Record anti-pattern if failed
      if (trace.outcome === 'failure' && trace.approach && trace.failureReason) {
        const antiPattern = `${trace.approach}: ${trace.failureReason.slice(0, 100)}`;
        if (!context.skills.antiPatterns.includes(antiPattern)) {
          context.skills.antiPatterns.push(antiPattern);
          // Keep bounded
          if (context.skills.antiPatterns.length > 10) {
            context.skills.antiPatterns = context.skills.antiPatterns.slice(-10);
          }
        }
      }

      // 5. Persist
      context.lastUpdated = Date.now();
      this.store.upsert(context);

      // 6. Living Agent Soul: significance-gated LLM reflection (async, non-blocking)
      if (this.soulReflector) {
        this.soulReflector.reflectOnTrace(agentId, trace, context).catch(() => {
          /* Soul reflection is fire-and-forget — never blocks */
        });
      }
    } catch {
      // Best-effort — agent context update must never block the pipeline
    }
  }

  private extractEpisode(trace: ExecutionTrace): AgentEpisode {
    const outcome: EpisodeOutcome =
      trace.outcome === 'success' ? 'success' : trace.outcome === 'escalated' ? 'partial' : 'failed';

    let lesson: string;
    if (trace.outcome === 'success') {
      const oracleCount = Object.keys(trace.oracleVerdicts ?? {}).length;
      lesson = `Completed successfully${oracleCount > 0 ? ` (${oracleCount} oracles passed)` : ''}.`;
    } else if (trace.failureReason) {
      lesson = `Failed: ${trace.failureReason.slice(0, 120)}`;
    } else {
      const failedOracles = Object.entries(trace.oracleVerdicts ?? {})
        .filter(([, v]) => !v)
        .map(([k]) => k);
      lesson = failedOracles.length > 0 ? `Failed oracles: ${failedOracles.join(', ')}` : `Outcome: ${trace.outcome}`;
    }

    return {
      taskId: trace.taskId,
      taskSignature: trace.taskTypeSignature ?? 'unknown',
      outcome,
      lesson,
      filesInvolved: trace.affectedFiles ?? [],
      approachUsed: trace.approach ?? '',
      timestamp: trace.timestamp,
    };
  }

  private addEpisode(context: AgentContext, episode: AgentEpisode): void {
    // Most recent first
    context.memory.episodes.unshift(episode);
    // Bound to MAX_EPISODES
    if (context.memory.episodes.length > MAX_EPISODES) {
      context.memory.episodes = context.memory.episodes.slice(0, MAX_EPISODES);
    }
  }

  private updateProficiency(context: AgentContext, trace: ExecutionTrace): void {
    const sig = trace.taskTypeSignature!;
    const existing = context.skills.proficiencies[sig];

    const totalAttempts = (existing?.totalAttempts ?? 0) + 1;
    const successes = (existing?.totalAttempts ?? 0) * (existing?.successRate ?? 0) + (trace.outcome === 'success' ? 1 : 0);
    const successRate = totalAttempts > 0 ? successes / totalAttempts : 0;

    // Derive level from success rate and attempts
    let level: SkillLevel = 'novice';
    if (totalAttempts >= 5 && successRate >= 0.8) {
      level = 'expert';
    } else if (totalAttempts >= 3 && successRate >= 0.5) {
      level = 'competent';
    }

    // Override with CapabilityModel if available (more statistically rigorous)
    if (this.capabilityModel) {
      const cap = this.capabilityModel.getCapabilityByKey(context.identity.agentId, sig);
      if (cap.capability !== null) {
        level = cap.capability >= 0.7 ? 'expert' : cap.capability >= 0.4 ? 'competent' : 'novice';
      }
    }

    context.skills.proficiencies[sig] = {
      taskSignature: sig,
      level,
      successRate,
      totalAttempts,
      lastAttempt: trace.timestamp,
    };
  }
}
