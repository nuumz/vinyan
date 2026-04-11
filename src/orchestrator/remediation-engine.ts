/**
 * Remediation Engine — fast-tier LLM-based command correction.
 *
 * When a tool command fails with a recoverable error, this engine uses a
 * fast/cheap LLM to suggest a corrected command. Follows the same pattern
 * as UnderstandingEngine: circuit-breaker protected, budget-gated.
 *
 * A3 compliant: the LLM is advisory — the orchestrator decides whether to
 * execute the suggestion based on confidence threshold.
 */

import type { LLMProvider } from './types.ts';
import type { ToolFailureAnalysis } from './tool-failure-classifier.ts';

export interface RemediationSuggestion {
  action: 'retry_corrected' | 'escalate';
  correctedCommand?: string;
  reasoning: string;
  confidence: number;
}

const REMEDIATION_TIMEOUT_MS = 5000;
const MAX_OUTPUT_TOKENS = 300;
const CONFIDENCE_THRESHOLD = 0.6;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

export class RemediationEngine {
  private provider: LLMProvider;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  /** Provider ID for trace attribution. */
  get providerId(): string {
    return this.provider.id;
  }

  /**
   * Suggest a corrected command for a failed tool execution.
   * Returns `{ action: 'escalate' }` if circuit is open or LLM can't help.
   */
  async suggest(
    goal: string,
    failedCommand: string,
    analysis: ToolFailureAnalysis,
    platform: string,
  ): Promise<RemediationSuggestion> {
    // Circuit breaker: skip LLM if it's been failing
    if (Date.now() < this.circuitOpenUntil) {
      return { action: 'escalate', reasoning: 'Remediation circuit breaker open', confidence: 0 };
    }

    try {
      const suggestion = await this.callLLM(goal, failedCommand, analysis, platform);
      this.consecutiveFailures = 0;
      return suggestion;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
      }
      return { action: 'escalate', reasoning: 'Remediation LLM call failed', confidence: 0 };
    }
  }

  /** Confidence threshold — only execute suggestions above this. */
  get confidenceThreshold(): number {
    return CONFIDENCE_THRESHOLD;
  }

  private async callLLM(
    goal: string,
    failedCommand: string,
    analysis: ToolFailureAnalysis,
    platform: string,
  ): Promise<RemediationSuggestion> {
    const osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';

    const response = await withTimeout(
      this.provider.generate({
        systemPrompt: `You are a tool failure diagnostician. A shell command failed. Suggest a corrected command or escalate.

Rules:
- Only suggest retry_corrected if you're confident the fix will work
- For app names: check the exact application name on the user's OS
- macOS apps often have different names than expected (e.g., "Microsoft Outlook" not "outlook", "Google Chrome" not "chrome")
- If the error is ambiguous or you're unsure, escalate

Respond ONLY with valid JSON, no markdown:
{"action":"retry_corrected"|"escalate","correctedCommand":"...","reasoning":"...","confidence":0.0-1.0}`,
        userPrompt: `Goal: ${goal}
Failed command: ${failedCommand}
Error: ${analysis.originalError}
Error type: ${analysis.type}
Exit code: ${analysis.exitCode}
OS: ${osName}`,
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
      }),
      REMEDIATION_TIMEOUT_MS,
    );

    const content = response.content.trim();
    const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        action: parsed.action === 'retry_corrected' ? 'retry_corrected' : 'escalate',
        correctedCommand: parsed.correctedCommand,
        reasoning: parsed.reasoning ?? '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      };
    } catch {
      return { action: 'escalate', reasoning: 'Failed to parse LLM response', confidence: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Timeout helper (same pattern as intent-resolver.ts)
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Remediation timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
