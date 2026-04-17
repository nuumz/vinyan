/**
 * Agent Context Types — persistent identity, episodic memory, and learned skills.
 *
 * Transforms workers from stateless executors into contextual agents with
 * unique personalities, cross-session memory, and self-improvement capability.
 *
 * Design constraints:
 *   - Context is ADVISORY, not GOVERNING (A3: deterministic governance preserved)
 *   - Agent never self-evaluates (A1: epistemic separation)
 *   - Cold-start agents derive initial context from CapabilityModel + traces
 *   - Episodes bounded to MAX_EPISODES to prevent prompt bloat
 *   - All fields JSON-serializable for IPC boundary crossing
 *
 * Source of truth: ultraplan — Agent Contextual Redesign
 */

export const MAX_EPISODES = 20;

export type SkillLevel = 'novice' | 'competent' | 'expert';
export type EpisodeOutcome = 'success' | 'partial' | 'failed';

export interface AgentIdentity {
  /** Phase 2: AgentSpec.id from the registry (e.g., 'ts-coder', 'writer'). */
  agentId: string;
  /** Short natural-language persona: "methodical code reviewer", "fast prototyper". */
  persona: string;
  /** Derived from positive CapabilityModel scores. */
  strengths: string[];
  /** Derived from negative CapabilityModel scores. */
  weaknesses: string[];
  /** Behavioral tendency: "reads thoroughly before editing", "iterates quickly". */
  approachStyle: string;
}

export interface AgentEpisode {
  taskId: string;
  taskSignature: string;
  outcome: EpisodeOutcome;
  /** 1-2 sentence takeaway from the task. */
  lesson: string;
  filesInvolved: string[];
  approachUsed: string;
  timestamp: number;
}

export interface EpisodicMemory {
  /** Bounded to MAX_EPISODES, most recent first. */
  episodes: AgentEpisode[];
  /** Compressed lessons from all episodes — updated during sleep cycle. */
  lessonsSummary: string;
}

export interface SkillProficiency {
  taskSignature: string;
  level: SkillLevel;
  successRate: number;
  totalAttempts: number;
  lastAttempt: number;
}

export interface LearnedSkills {
  /** taskSignature → proficiency record. */
  proficiencies: Record<string, SkillProficiency>;
  /** taskSignature → preferred approach description. */
  preferredApproaches: Record<string, string>;
  /** "Never do X" rules extracted from failures. */
  antiPatterns: string[];
}

export interface AgentContext {
  identity: AgentIdentity;
  memory: EpisodicMemory;
  skills: LearnedSkills;
  lastUpdated: number;
}

/** Empty context for cold-start agents before any derivation. */
export function createEmptyContext(agentId: string): AgentContext {
  return {
    identity: {
      agentId,
      persona: '',
      strengths: [],
      weaknesses: [],
      approachStyle: '',
    },
    memory: {
      episodes: [],
      lessonsSummary: '',
    },
    skills: {
      proficiencies: {},
      preferredApproaches: {},
      antiPatterns: [],
    },
    lastUpdated: Date.now(),
  };
}
