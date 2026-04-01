import { describe, test, expect } from "bun:test";
import { clampByTier, clampByTransport, clampConfidence } from "../../src/oracle/tier-clamp.ts";

describe("tier-clamp", () => {
  describe("clampByTier", () => {
    test("heuristic caps at 0.9", () => {
      expect(clampByTier(1.0, "heuristic")).toBe(0.9);
    });

    test("deterministic allows 1.0", () => {
      expect(clampByTier(1.0, "deterministic")).toBe(1.0);
    });

    test("below cap passes through", () => {
      expect(clampByTier(0.5, "deterministic")).toBe(0.5);
    });

    test("probabilistic caps at 0.7", () => {
      expect(clampByTier(0.9, "probabilistic")).toBe(0.7);
    });

    test("speculative caps at 0.4", () => {
      expect(clampByTier(1.0, "speculative")).toBe(0.4);
    });

    test("undefined tier passes through", () => {
      expect(clampByTier(0.8, undefined)).toBe(0.8);
    });

    test("unknown tier defaults to 1.0 cap", () => {
      expect(clampByTier(0.9, "unknown-tier")).toBe(0.9);
    });
  });

  describe("clampByTransport", () => {
    test("stdio has no degradation", () => {
      expect(clampByTransport(1.0, "stdio")).toBe(1.0);
    });

    test("websocket caps at 0.95", () => {
      expect(clampByTransport(1.0, "websocket")).toBe(0.95);
    });

    test("websocket below cap passes through", () => {
      expect(clampByTransport(0.9, "websocket")).toBe(0.9);
    });

    test("http caps at 0.7", () => {
      expect(clampByTransport(1.0, "http")).toBe(0.7);
    });

    test("undefined transport passes through", () => {
      expect(clampByTransport(0.8, undefined)).toBe(0.8);
    });
  });

  describe("clampConfidence (combined)", () => {
    test("tier cap is binding when lower than transport", () => {
      // heuristic=0.9, websocket=0.95 → 0.9
      expect(clampConfidence(1.0, "heuristic", "websocket")).toBe(0.9);
    });

    test("transport cap is binding when lower than tier", () => {
      // deterministic=1.0, websocket=0.95 → 0.95
      expect(clampConfidence(1.0, "deterministic", "websocket")).toBe(0.95);
    });

    test("both caps applied — lowest wins", () => {
      // probabilistic=0.7, http=0.7 → 0.7
      expect(clampConfidence(1.0, "probabilistic", "http")).toBe(0.7);
    });

    test("local stdio with deterministic passes through", () => {
      expect(clampConfidence(1.0, "deterministic", "stdio")).toBe(1.0);
    });

    test("no tier no transport passes through", () => {
      expect(clampConfidence(0.6)).toBe(0.6);
    });
  });
});
