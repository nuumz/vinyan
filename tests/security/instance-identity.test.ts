/**
 * Instance Identity Tests — Ed25519 keypair, sign/verify
 */
import { describe, test, expect } from "bun:test";
import {
  generateIdentity,
  signMessage,
  verifySignature,
} from "../../src/security/instance-identity.ts";

describe("Instance Identity", () => {
  test("generateIdentity creates valid identity", async () => {
    const identity = await generateIdentity();

    expect(identity.instanceId).toBeTruthy();
    expect(identity.publicKey).toBeTruthy();
    expect(identity.privateKey).toBeTruthy();
    expect(identity.createdAt).toBeGreaterThan(0);

    // UUIDv4 format
    expect(identity.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Base64 encoded keys
    expect(() => Buffer.from(identity.publicKey, "base64")).not.toThrow();
    expect(() => Buffer.from(identity.privateKey, "base64")).not.toThrow();
  });

  test("two identities have different keys", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();

    expect(id1.instanceId).not.toBe(id2.instanceId);
    expect(id1.publicKey).not.toBe(id2.publicKey);
    expect(id1.privateKey).not.toBe(id2.privateKey);
  });

  test("sign and verify round-trip succeeds", async () => {
    const identity = await generateIdentity();
    const message = "message_id_123 + 1711900000000 + {\"type\":\"heartbeat\"}";

    const signature = await signMessage(identity.privateKey, message);
    expect(signature).toBeTruthy();

    const valid = await verifySignature(identity.publicKey, message, signature);
    expect(valid).toBe(true);
  });

  test("tampered message is rejected", async () => {
    const identity = await generateIdentity();
    const message = "original message";

    const signature = await signMessage(identity.privateKey, message);

    const valid = await verifySignature(identity.publicKey, "tampered message", signature);
    expect(valid).toBe(false);
  });

  test("wrong public key rejects signature", async () => {
    const identity1 = await generateIdentity();
    const identity2 = await generateIdentity();

    const signature = await signMessage(identity1.privateKey, "test message");

    const valid = await verifySignature(identity2.publicKey, "test message", signature);
    expect(valid).toBe(false);
  });

  test("corrupted signature returns false (no throw)", async () => {
    const identity = await generateIdentity();

    const valid = await verifySignature(identity.publicKey, "test", "not-valid-base64!!");
    expect(valid).toBe(false);
  });

  test("empty message can be signed and verified", async () => {
    const identity = await generateIdentity();

    const signature = await signMessage(identity.privateKey, "");
    const valid = await verifySignature(identity.publicKey, "", signature);
    expect(valid).toBe(true);
  });
});
