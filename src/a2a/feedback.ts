/**
 * Knowledge Feedback Loop — structured feedback for shared knowledge/verdicts.
 *
 * Closes the learning loop: when Instance B applies knowledge from Instance A
 * and verifies the result, B sends structured feedback back to A.
 *
 * Rate limit: max 1 feedback per (target_id, sender).
 * Trust impact: accurate → positive, inaccurate → negative.
 *
 * Source of truth: Plan Phase G4
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';
import type { PeerTrustManager } from './peer-trust.ts';

export type FeedbackOutcome = 'accurate' | 'inaccurate' | 'partially_accurate' | 'inapplicable';

export interface EcpFeedback {
  feedback_id: string;
  target_type: 'verdict' | 'knowledge' | 'rule';
  target_id: string;
  outcome: FeedbackOutcome;
  details?: string;
  evidence?: Array<{ file: string; line: number; snippet: string }>;
  context?: Record<string, unknown>;
  sender_instance_id: string;
  timestamp: number;
}

export interface FeedbackSummary {
  target_id: string;
  accurate: number;
  inaccurate: number;
  partially_accurate: number;
  inapplicable: number;
  total: number;
}

export interface FeedbackConfig {
  instanceId: string;
  bus?: EventBus<VinyanBusEvents>;
  trustManager?: PeerTrustManager;
}

function genId(): string {
  return `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export class FeedbackManager {
  private feedbacks = new Map<string, EcpFeedback>();
  private sentKeys = new Set<string>();
  private byTarget = new Map<string, EcpFeedback[]>();

  constructor(private config: FeedbackConfig) {}

  sendFeedback(
    targetType: 'verdict' | 'knowledge' | 'rule',
    targetId: string,
    outcome: FeedbackOutcome,
    options?: {
      details?: string;
      evidence?: Array<{ file: string; line: number; snippet: string }>;
      context?: Record<string, unknown>;
    },
  ): EcpFeedback | null {
    const key = `${targetId}:${this.config.instanceId}`;
    if (this.sentKeys.has(key)) return null;

    const feedback: EcpFeedback = {
      feedback_id: genId(),
      target_type: targetType,
      target_id: targetId,
      outcome,
      details: options?.details,
      evidence: options?.evidence,
      context: options?.context,
      sender_instance_id: this.config.instanceId,
      timestamp: Date.now(),
    };

    this.feedbacks.set(feedback.feedback_id, feedback);
    this.sentKeys.add(key);
    this.appendToTarget(targetId, feedback);
    return feedback;
  }

  handleFeedback(peerId: string, feedback: EcpFeedback): boolean {
    const key = `${feedback.target_id}:${feedback.sender_instance_id}`;
    if (this.sentKeys.has(key)) return false;

    this.feedbacks.set(feedback.feedback_id, feedback);
    this.sentKeys.add(key);
    this.appendToTarget(feedback.target_id, feedback);

    // Trust impact based on outcome
    if (feedback.outcome === 'accurate' || feedback.outcome === 'partially_accurate') {
      this.config.trustManager?.recordInteraction(peerId, true);
    } else if (feedback.outcome === 'inaccurate') {
      this.config.trustManager?.recordInteraction(peerId, false);
    }
    // "inapplicable" → no trust impact

    this.config.bus?.emit('a2a:feedbackReceived', {
      peerId,
      feedbackId: feedback.feedback_id,
      targetId: feedback.target_id,
      outcome: feedback.outcome,
    });

    return true;
  }

  getFeedbackSummary(targetId: string): FeedbackSummary {
    const items = this.byTarget.get(targetId) ?? [];
    const summary: FeedbackSummary = {
      target_id: targetId,
      accurate: 0,
      inaccurate: 0,
      partially_accurate: 0,
      inapplicable: 0,
      total: items.length,
    };

    for (const fb of items) {
      summary[fb.outcome]++;
    }

    return summary;
  }

  hasSentFeedback(targetId: string, senderId: string): boolean {
    return this.sentKeys.has(`${targetId}:${senderId}`);
  }

  private appendToTarget(targetId: string, feedback: EcpFeedback): void {
    const list = this.byTarget.get(targetId) ?? [];
    list.push(feedback);
    this.byTarget.set(targetId, list);
  }
}
