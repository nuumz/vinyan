/**
 * A2A Agent Card Tests — PH5.6.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateAgentCard } from "../../src/a2a/agent-card.ts";
import { A2AAgentCardSchema } from "../../src/a2a/types.ts";
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
});
