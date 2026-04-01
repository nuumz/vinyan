/**
 * Security Types — Zod schemas for auth and instance identity.
 *
 * Source of truth: spec/tdd.md §22 (API auth), §23 (instance identity)
 */
import { z } from "zod/v4";

export const AuthContextSchema = z.object({
  authenticated: z.boolean(),
  apiKey: z.string().optional(),
  source: z.enum(["bearer", "anonymous"]),
});

export type AuthContext = z.infer<typeof AuthContextSchema>;

export const InstanceIdentitySchema = z.object({
  instanceId: z.string(),
  publicKey: z.string(),   // Base64-encoded Ed25519 public key
  privateKey: z.string(),  // Base64-encoded Ed25519 private key (never transmitted)
  createdAt: z.number(),
});

export type InstanceIdentity = z.infer<typeof InstanceIdentitySchema>;
