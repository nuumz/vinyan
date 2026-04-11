/**
 * Security Types — Zod schemas for auth and instance identity.
 *
 * Source of truth: spec/tdd.md §22 (API auth), §23 (instance identity)
 */
import { z } from 'zod/v4';

export const RoleSchema = z.enum(['readonly', 'operator', 'admin']);

export type Role = z.infer<typeof RoleSchema>;

export const AuthContextSchema = z.object({
  authenticated: z.boolean(),
  apiKey: z.string().optional(),
  role: RoleSchema.optional(),
  source: z.enum(['bearer', 'mtls', 'anonymous']),
  instanceId: z.string().optional(),
});

export type AuthContext = z.infer<typeof AuthContextSchema>;

export const TokenConfigSchema = z.object({
  token: z.string().min(1),
  role: RoleSchema,
  instanceId: z.string().optional(),
});

export type TokenConfig = z.infer<typeof TokenConfigSchema>;

export const TokenFileSchema = z.object({
  tokens: z.array(TokenConfigSchema),
});

export type TokenFile = z.infer<typeof TokenFileSchema>;

export const InstanceIdentitySchema = z.object({
  instanceId: z.string(),
  publicKey: z.string(), // Base64-encoded Ed25519 public key
  privateKey: z.string(), // Base64-encoded Ed25519 private key (never transmitted)
  createdAt: z.number(),
});

export type InstanceIdentity = z.infer<typeof InstanceIdentitySchema>;
