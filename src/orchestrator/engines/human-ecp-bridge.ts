/**
 * Human-in-the-Loop ECP Bridge — ReasoningEngine for human review.
 *
 * Emits a bus event requesting human review and waits for a response.
 * Used for high-risk decisions, domain expertise, or approval gates.
 *
 * A5 compliant: human review is evidence-derived (deterministic evidence source).
 * A6 compliant: zero-trust — human explicitly authorizes actions.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { ReasoningEngine, RERequest, REResponse } from '../types.ts';

export interface HumanBridgeConfig {
  bus: VinyanBus;
  /** Timeout in ms for human response (default: 5 minutes). */
  timeoutMs?: number;
}

export class HumanECPBridge implements ReasoningEngine {
  readonly id = 'human-bridge';
  readonly engineType = 'external' as const;
  readonly capabilities = ['human-review', 'approval', 'domain-expertise'];
  readonly tier = undefined; // non-LLM — no tier mapping
  readonly maxContextTokens = undefined;

  private bus: VinyanBus;
  private timeoutMs: number;

  constructor(config: HumanBridgeConfig) {
    this.bus = config.bus;
    this.timeoutMs = config.timeoutMs ?? 300_000; // 5 minutes default
  }

  async execute(request: RERequest): Promise<REResponse> {
    const startTime = performance.now();
    const taskId = `human-${Date.now().toString(36)}`;

    // Register response listener BEFORE emitting request (bus is synchronous)
    const response = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error(`Human review timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const unsub = this.bus.on('human:review_completed', (payload) => {
        if (payload.taskId === taskId) {
          clearTimeout(timeout);
          unsub();
          resolve(payload.content);
        }
      });

      // Emit review request after listener is ready
      this.bus.emit('human:review_requested', {
        taskId,
        prompt: request.userPrompt,
        timeoutMs: this.timeoutMs,
      });
    });

    const durationMs = performance.now() - startTime;

    return {
      content: response,
      toolCalls: [],
      tokensUsed: { input: request.userPrompt.length, output: response.length },
      engineId: this.id,
      terminationReason: 'completed',
      providerMeta: { durationMs, source: 'human-review' },
    };
  }
}
