/**
 * HMS Config — Zod schema for Hallucination Mitigation System.
 *
 * Disabled by default. Opt-in via vinyan.json: { hms: { enabled: true } }
 */
import { z } from 'zod/v4';

export const HMSConfigSchema = z.object({
  enabled: z.boolean().default(false),
  grounding: z
    .object({
      enabled: z.boolean().default(true),
      max_claims: z.number().positive().default(20),
    })
    .default({ enabled: true, max_claims: 20 }),
  overconfidence: z
    .object({
      enabled: z.boolean().default(true),
      threshold: z.number().min(0).max(1).default(0.6),
    })
    .default({ enabled: true, threshold: 0.6 }),
  cross_validation: z
    .object({
      enabled: z.boolean().default(false),
      max_probes_per_claim: z.number().positive().default(3),
      max_claims: z.number().positive().default(5),
      probe_budget_tokens: z.number().positive().default(1000),
    })
    .default({ enabled: false, max_probes_per_claim: 3, max_claims: 5, probe_budget_tokens: 1000 }),
  risk_weights: z
    .object({
      grounding: z.number().min(0).max(1).default(0.35),
      overconfidence: z.number().min(0).max(1).default(0.15),
      structural: z.number().min(0).max(1).default(0.25),
      critic: z.number().min(0).max(1).default(0.15),
      cross_validation: z.number().min(0).max(1).default(0.1),
    })
    .default({ grounding: 0.35, overconfidence: 0.15, structural: 0.25, critic: 0.15, cross_validation: 0.1 }),
  /** Wave A: when enabled AND risk.score >= threshold, HMS blocks verification
   *  instead of just attenuating confidence. Off by default for backward compat. */
  blocking: z
    .object({
      enabled: z.boolean().default(false),
      threshold: z.number().min(0).max(1).default(0.75),
    })
    .default({ enabled: false, threshold: 0.75 }),
});

export type HMSConfig = z.infer<typeof HMSConfigSchema>;
