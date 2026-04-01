/**
 * A2A Agent Card Tests — PH5.6 + Phase D1.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateAgentCard, isVinyanPeer, getECPExtension } from "../../src/a2a/agent-card.ts";
import { A2AAgentCardSchema } from "../../src/a2a/types.ts";
import type { A2AAgentCard } from "../../src/a2a/types.ts";
import { registerOracle, clearDynamicOracles } from "../../src/oracle/registry.ts";

afterEach(() => {
  clearDynamicOracles();
});

describe("generateAgentCard", () => {
  test("agent card has correct name and version", () => {
    const card = generateAgentCard("http://localhost:3000");
    expect(card.name).toBe("Vinyan ENS");
    expect(card.version).toBe("5.0.0");
  });

  test("skills populated from oracle registry", () => {
    const card = generateAgentCard("http://localhost:3000");
    // Built-in oracles: ast, type, dep, test, lint
    expect(card.skills.length).toBeGreaterThanOrEqual(5);

    const skillIds = card.skills.map((s) => s.id);
    expect(skillIds).toContain("ast-oracle");
    expect(skillIds).toContain("type-oracle");
    expect(skillIds).toContain("dep-oracle");
    expect(skillIds).toContain("test-oracle");
    expect(skillIds).toContain("lint-oracle");
  });

  test("each skill has name and description", () => {
    const card = generateAgentCard("http://localhost:3000");
    for (const skill of card.skills) {
      expect(skill.name).toContain("Vinyan");
      expect(skill.description).toContain("oracle");
      expect(skill.id).toBeTruthy();
    }
  });

  test("dynamic oracles appear in skills", () => {
    registerOracle("python-lint", {
      command: "ruff check",
      languages: ["python"],
      tier: "deterministic",
    });

    const card = generateAgentCard("http://localhost:3000");
    const pythonLint = card.skills.find((s) => s.id === "python-lint");
    expect(pythonLint).toBeDefined();
    expect(pythonLint!.name).toBe("Vinyan python-lint");
    expect(pythonLint!.tags).toEqual(["python"]);
  });

  test("card validates against A2AAgentCardSchema", () => {
    const card = generateAgentCard("http://localhost:3000");
    const result = A2AAgentCardSchema.safeParse(card);
    expect(result.success).toBe(true);
  });

  test("URL matches baseUrl parameter", () => {
    const card = generateAgentCard("https://vinyan.example.com");
    expect(card.url).toBe("https://vinyan.example.com");
  });

  test("capabilities reflect current support", () => {
    const card = generateAgentCard("http://localhost:3000");
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  test("card without identity has no x-vinyan-ecp", () => {
    const card = generateAgentCard("http://localhost:3000");
    expect(card["x-vinyan-ecp"]).toBeUndefined();
  });

  test("card with identity has x-vinyan-ecp extension", () => {
    const card = generateAgentCard("http://localhost:3000", {
      instanceId: "inst-001",
      publicKey: "pk-001",
    });

    const ext = card["x-vinyan-ecp"];
    expect(ext).toBeDefined();
    expect(ext!.protocol).toBe("vinyan-ecp");
    expect(ext!.ecp_version).toBe(1);
    expect(ext!.instance_id).toBe("inst-001");
    expect(ext!.public_key).toBe("pk-001");
  });

  test("oracle_capabilities matches registered oracles", () => {
    const card = generateAgentCard("http://localhost:3000", {
      instanceId: "inst-001",
      publicKey: "pk-001",
    });

    const ext = card["x-vinyan-ecp"]!;
    const oracleNames = ext.oracle_capabilities.map(o => o.name);
    expect(oracleNames).toContain("ast-oracle");
    expect(oracleNames).toContain("type-oracle");

    const ast = ext.oracle_capabilities.find(o => o.name === "ast-oracle");
    expect(ast!.tier).toBe("deterministic");
    expect(ast!.languages).toContain("typescript");
  });

  test("features array contains default features", () => {
    const card = generateAgentCard("http://localhost:3000", {
      instanceId: "inst-001",
      publicKey: "pk-001",
    });

    const features = card["x-vinyan-ecp"]!.features;
    expect(features).toContain("knowledge_sharing");
    expect(features).toContain("feedback_loop");
    expect(features).toContain("file_invalidation");
  });

  test("capability_version parameter is respected", () => {
    const card = generateAgentCard("http://localhost:3000", {
      instanceId: "inst-001",
      publicKey: "pk-001",
    }, 42);

    expect(card["x-vinyan-ecp"]!.capability_version).toBe(42);
  });

  test("card with identity validates against A2AAgentCardSchema", () => {
    const card = generateAgentCard("http://localhost:3000", {
      instanceId: "inst-001",
      publicKey: "pk-001",
    });

    const result = A2AAgentCardSchema.safeParse(card);
    expect(result.success).toBe(true);
  });
});

// ── isVinyanPeer ──────────────────────────────────────────────────────

describe("isVinyanPeer", () => {
  test("returns true for card with x-vinyan-ecp extension", () => {
    const card = generateAgentCard("http://localhost:3000", {
      instanceId: "inst-001",
      publicKey: "pk-001",
    });
    expect(isVinyanPeer(card)).toBe(true);
  });

  test("returns false for card without x-vinyan-ecp", () => {
    const card = generateAgentCard("http://localhost:3000");
    expect(isVinyanPeer(card)).toBe(false);
  });

  test("returns false for non-Vinyan card with different extension shape", () => {
    const card: A2AAgentCard = {
      name: "Other Agent",
      description: "Not Vinyan",
      url: "http://localhost:3000",
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: false },
      skills: [],
    };
    expect(isVinyanPeer(card)).toBe(false);
  });
});

// ── getECPExtension ───────────────────────────────────────────────────

describe("getECPExtension", () => {
  test("returns extension for Vinyan card", () => {
    const card = generateAgentCard("http://localhost:3000", {
      instanceId: "inst-001",
      publicKey: "pk-001",
    });

    const ext = getECPExtension(card);
    expect(ext).not.toBeNull();
    expect(ext!.instance_id).toBe("inst-001");
    expect(ext!.public_key).toBe("pk-001");
    expect(ext!.protocol).toBe("vinyan-ecp");
  });

  test("returns null for non-Vinyan card", () => {
    const card = generateAgentCard("http://localhost:3000");
    expect(getECPExtension(card)).toBeNull();
  });
});
