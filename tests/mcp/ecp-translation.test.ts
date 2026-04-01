import { describe, test, expect } from "bun:test";
import { ecpToMcp, mcpToEcp } from "../../src/mcp/ecp-translation.ts";
import { buildVerdict } from "../../src/core/index.ts";
import type { OracleVerdict } from "../../src/core/types.ts";
import type { MCPToolResult } from "../../src/mcp/types.ts";

// ── ecpToMcp ────────────────────────────────────────────────────────

describe("ecpToMcp", () => {
  test("verified=true → text content with verification details", () => {
    const verdict: OracleVerdict = buildVerdict({
      verified: true,
      evidence: [{ file: "src/app.ts", line: 10, snippet: "export class App {}" }],
      fileHashes: { "src/app.ts": "abc123" },
      oracleName: "ast",
      duration_ms: 42,
    });

    const result = ecpToMcp(verdict);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.isError).toBe(false);

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.verified).toBe(true);
    expect(payload.confidence).toBe(1.0);
    expect(payload.evidence).toHaveLength(1);
    expect(payload.oracleName).toBe("ast");
    expect(payload.duration_ms).toBe(42);
  });

  test("verified=false → text content with error details", () => {
    const verdict: OracleVerdict = buildVerdict({
      verified: false,
      type: "known",
      evidence: [],
      fileHashes: {},
      reason: "Symbol not found",
      oracleName: "ast",
      duration_ms: 15,
    });

    const result = ecpToMcp(verdict);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.verified).toBe(false);
    expect(payload.reason).toBe("Symbol not found");
  });

  test("type='unknown' → verified: null with insufficient evidence", () => {
    const verdict: OracleVerdict = buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      oracleName: "ast",
      duration_ms: 0,
    });

    const result = ecpToMcp(verdict);

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.verified).toBeNull();
    expect(payload.reason).toBe("insufficient evidence");
    expect(payload.oracleName).toBe("ast");
  });
});

// ── mcpToEcp ────────────────────────────────────────────────────────

describe("mcpToEcp", () => {
  const successResult: MCPToolResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          verified: true,
          evidence: [{ file: "src/app.ts", line: 5, snippet: "found" }],
          fileHashes: { "src/app.ts": "hash123" },
        }),
      },
    ],
  };

  const errorResult: MCPToolResult = {
    content: [{ type: "text", text: "Something went wrong" }],
    isError: true,
  };

  test("local trust → confidence 0.7", () => {
    const verdict = mcpToEcp(successResult, "local");
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.type).toBe("uncertain");
  });

  test("network trust → confidence 0.40 (http + provisional peer)", () => {
    const verdict = mcpToEcp(successResult, "network");
    expect(verdict.confidence).toBe(0.40);
    expect(verdict.type).toBe("uncertain");
  });

  test("remote trust → confidence 0.25 (http + untrusted peer)", () => {
    const verdict = mcpToEcp(successResult, "remote");
    expect(verdict.confidence).toBe(0.25);
    expect(verdict.type).toBe("uncertain");
  });

  test("error result → verified=false", () => {
    const verdict = mcpToEcp(errorResult, "local");
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBe("Something went wrong");
    expect(verdict.type).toBe("uncertain");
  });

  test("all MCP results get type 'uncertain' (A5)", () => {
    const verdict = mcpToEcp(successResult, "local");
    expect(verdict.type).toBe("uncertain");
    // Even high-confidence results from external sources never get 'known'
    expect(verdict.type).not.toBe("known");
  });

  test("structured content is parsed into evidence", () => {
    const verdict = mcpToEcp(successResult, "local");
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.file).toBe("src/app.ts");
    expect(verdict.fileHashes["src/app.ts"]).toBe("hash123");
  });

  test("unstructured text is treated as opaque success", () => {
    const unstructured: MCPToolResult = {
      content: [{ type: "text", text: "All checks passed" }],
    };
    const verdict = mcpToEcp(unstructured, "network");
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe("uncertain");
    expect(verdict.confidence).toBe(0.40);
  });
});

// ── Roundtrip ───────────────────────────────────────────────────────

describe("ECP translation roundtrip", () => {
  test("ecp → mcp → ecp preserves verified state", () => {
    const original: OracleVerdict = buildVerdict({
      verified: true,
      evidence: [{ file: "src/x.ts", line: 1, snippet: "ok" }],
      fileHashes: { "src/x.ts": "h1" },
      oracleName: "ast",
      duration_ms: 10,
    });

    const mcp = ecpToMcp(original);
    const roundtripped = mcpToEcp(mcp, "local");

    expect(roundtripped.verified).toBe(original.verified);
    expect(roundtripped.evidence).toHaveLength(1);
    // Confidence is capped by trust level in roundtrip
    expect(roundtripped.confidence).toBe(0.7);
    // Type degrades to 'uncertain' through MCP boundary (A5)
    expect(roundtripped.type).toBe("uncertain");
  });
});
