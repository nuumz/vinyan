/**
 * Instance Identity — Ed25519 keypair generation and message signing.
 *
 * Each Vinyan instance has a unique Ed25519 keypair for VIIP authentication.
 * Keypair stored at ~/.vinyan/instance-key.json (not PEM — simpler JSON format).
 *
 * Source of truth: spec/a2a-protocol.md §4.1, spec/tdd.md §23
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { InstanceIdentity } from './types.ts';

/**
 * Load or generate the instance identity.
 *
 * @param keyPath — path to the identity JSON file (e.g., ~/.vinyan/instance-key.json)
 */
export async function loadOrCreateIdentity(keyPath: string): Promise<InstanceIdentity> {
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf-8');
    return JSON.parse(raw) as InstanceIdentity;
  }

  const identity = await generateIdentity();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

/**
 * Generate a new Ed25519 identity.
 */
export async function generateIdentity(): Promise<InstanceIdentity> {
  const keyPair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;

  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  return {
    instanceId: crypto.randomUUID(),
    publicKey: Buffer.from(publicKeyRaw).toString('base64'),
    privateKey: Buffer.from(privateKeyRaw).toString('base64'),
    createdAt: Date.now(),
  };
}

/**
 * Sign a message with the instance's private key.
 *
 * @returns Base64-encoded Ed25519 signature
 */
export async function signMessage(privateKeyBase64: string, message: string): Promise<string> {
  const privateKeyBuffer = Buffer.from(privateKeyBase64, 'base64');
  const key = await crypto.subtle.importKey('pkcs8', privateKeyBuffer, 'Ed25519', false, ['sign']);

  const data = new TextEncoder().encode(message);
  const signature = await crypto.subtle.sign('Ed25519', key, data);
  return Buffer.from(signature).toString('base64');
}

/**
 * Verify a message signature against a public key.
 *
 * @returns true if signature is valid
 */
export async function verifySignature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const publicKeyBuffer = Buffer.from(publicKeyBase64, 'base64');
    const key = await crypto.subtle.importKey('raw', publicKeyBuffer, 'Ed25519', false, ['verify']);

    const data = new TextEncoder().encode(message);
    const signature = Buffer.from(signatureBase64, 'base64');
    return await crypto.subtle.verify('Ed25519', key, signature, data);
  } catch {
    return false;
  }
}
