# Vinyan Oracle SDK — Building ECP-Compatible Reasoning Engines

> **Version:** 1.0-draft | **Date:** 2026-04-01
> **Prerequisite:** [ecp-spec.md](ecp-spec.md) — the protocol this SDK implements
> **Reference implementation:** `src/oracle/python/` — a working Python (Pyright) oracle

---

## §1 Quick Start

An ECP oracle is a process that reads a **Hypothesis** from stdin and writes a **Verdict** to stdout. That's it.

### TypeScript (Bun) — 15 Lines

```typescript
// my-oracle/index.ts
import { createHash } from "crypto";
import { readFileSync } from "fs";

const input = await Bun.stdin.text();
const hypothesis = JSON.parse(input);
const start = performance.now();

// Your verification logic here
const content = readFileSync(hypothesis.target, "utf-8");
const verified = content.includes("export class AuthService");

const fileHash = createHash("sha256").update(content).digest("hex");
const verdict = {
  verified,
  evidence: verified
    ? [{ file: hypothesis.target, line: 1, snippet: "export class AuthService", contentHash: fileHash }]
    : [],
  fileHashes: { [hypothesis.target]: fileHash },
  duration_ms: Math.round(performance.now() - start),
};
process.stdout.write(JSON.stringify(verdict) + "\n");
```

Register: `vinyan.json` → `"oracles": { "my-oracle": { "command": "bun run my-oracle/index.ts", "tier": "heuristic" } }`

### Python — 20 Lines

```python
#!/usr/bin/env python3
import json, sys, hashlib, time

hypothesis = json.loads(sys.stdin.readline())
start = time.monotonic()

# Your verification logic here
with open(hypothesis["target"], "rb") as f:
    content = f.read()
    file_hash = hashlib.sha256(content).hexdigest()

verified = b"export class AuthService" in content

verdict = {
    "verified": verified,
    "evidence": [{"file": hypothesis["target"], "line": 1, "snippet": "found", "contentHash": file_hash}] if verified else [],
    "fileHashes": {hypothesis["target"]: file_hash},
    "duration_ms": round((time.monotonic() - start) * 1000),
}
print(json.dumps(verdict))
```

Register: `vinyan.json` → `"oracles": { "my-oracle": { "command": "python3 my-oracle.py", "tier": "heuristic" } }`

### Go, Rust, or Any Language

The contract is language-agnostic:
1. Read one line of JSON from stdin → `HypothesisTuple`
2. Do your verification
3. Write one line of JSON to stdout → `OracleVerdict`
4. Exit with code 0 (even if `verified: false`)

---

## §2 Oracle Contract

### Input: HypothesisTuple

```json
{
  "target": "src/auth/login.ts",
  "pattern": "type-check",
  "context": { "strict": true },
  "workspace": "/absolute/path/to/project"
}
```

| Field | Type | Required | Description |
|:------|:-----|:---------|:-----------|
| `target` | string | Yes | File path or symbol to verify |
| `pattern` | string | Yes | What to verify (see Pattern Catalog §3) |
| `context` | object | No | Pattern-specific parameters |
| `workspace` | string | Yes | Absolute path to project root |

### Output: OracleVerdict

```json
{
  "verified": true,
  "type": "known",
  "confidence": 1.0,
  "evidence": [{ "file": "src/auth/login.ts", "line": 15, "snippet": "export class AuthService", "contentHash": "sha256:abc..." }],
  "fileHashes": { "src/auth/login.ts": "sha256:abc..." },
  "duration_ms": 42
}
```

| Field | Type | Required | Default | Description |
|:------|:-----|:---------|:--------|:-----------|
| `verified` | boolean | **Yes** | — | Did verification pass? |
| `type` | string | No | `"known"` | Epistemic state (see §4) |
| `confidence` | number | No | `1.0` | Confidence in [0, 1] |
| `evidence` | Evidence[] | **Yes** | — | Structured evidence chain |
| `fileHashes` | Record | **Yes** | — | SHA-256 per inspected file |
| `duration_ms` | number | **Yes** | — | Execution time in ms |
| `reason` | string | No | — | Explanation when `!verified` |
| `errorCode` | string | No | — | Programmatic error code |
| `falsifiable_by` | string[] | No | — | What would invalidate this verdict |
| `temporal_context` | object | No | — | Evidence validity window |
| `deliberation_request` | object | No | — | Request more compute |

### Exit Codes

| Code | Meaning | Orchestrator Behavior |
|:-----|:--------|:---------------------|
| 0 | Normal completion | Parse stdout as verdict |
| Non-zero | Engine crash | Return `errorCode: "ORACLE_CRASH"` verdict |

**Critical distinction:** Verification failure (`verified: false`) is NOT a process failure. Exit 0 and write the failure verdict to stdout. Non-zero exit code means the engine itself broke, not that verification failed.

---

## §3 Pattern Catalog

### Built-in Patterns

| Pattern | Domain | Description | Typical Engines |
|:--------|:-------|:-----------|:----------------|
| `symbol-exists` | Code structure | Check if a named symbol exists in the target | AST parser (tree-sitter) |
| `function-signature` | Code structure | Verify function parameter count/types | AST parser |
| `import-exists` | Code structure | Check if a specific import exists | AST parser |
| `type-check` | Type safety | Run type checker on target | tsc, pyright, gopls |
| `dependency-check` | Dependencies | Compute blast radius of changes | Import graph analyzer |
| `test-pass` | Testing | Run test suite for target | bun test, pytest, go test |
| `lint-clean` | Code quality | Run linter on target | ESLint, ruff, golint |

### Custom Patterns

Define your own patterns for domain-specific verification:

| Convention | Example | Description |
|:-----------|:--------|:-----------|
| `{domain}-{action}` | `security-audit` | Security vulnerability scan |
| `{domain}-{action}` | `compliance-check` | Regulatory compliance verification |
| `{domain}-{action}` | `api-contract-valid` | API schema compatibility |
| `{domain}-{action}` | `perf-regression` | Performance regression detection |
| `{domain}-{action}` | `license-compatible` | License compatibility check |

**Naming rules:**
- Use kebab-case
- Domain-prefix all custom patterns to avoid collision
- Document expected `context` fields for your patterns

---

## §4 Epistemic Best Practices

The ECP protocol's power comes from honest epistemic reporting. Here's when to use each type:

### When to Return `type: "known"`

The engine has **definitive evidence** — the answer is provably correct or incorrect.

```json
{ "verified": true, "type": "known", "confidence": 1.0,
  "evidence": [{"file": "src/auth.ts", "line": 15, "snippet": "export class AuthService"}] }
```

Use when: compiler says "pass" or "fail", test passes or fails, symbol exists or doesn't.

### When to Return `type: "unknown"`

The engine **cannot determine** the answer. This is NOT an error — it's epistemic honesty.

```json
{ "verified": false, "type": "unknown", "confidence": 0,
  "reason": "Target file uses dynamic imports — static analysis cannot resolve" }
```

Use when: engine lacks capability for this case, target is outside engine's domain, insufficient information to analyze.

**The Orchestrator treats `"unknown"` as actionable intelligence** — it may route to a different engine, escalate, or request human judgment. Returning a wrong `"known"` is far worse than an honest `"unknown"`.

### When to Return `type: "uncertain"`

The engine has **partial evidence** but cannot reach a definitive conclusion.

```json
{ "verified": false, "type": "uncertain", "confidence": 0.4,
  "reason": "Potential SQL injection at line 42, but taint analysis inconclusive",
  "deliberation_request": { "reason": "Need deeper taint analysis", "suggestedBudget": 5000 } }
```

Use when: heuristic matches but could be false positive, analysis was partial (timed out or truncated), multiple interpretations exist.

### When to Return `type: "contradictory"`

The engine found **conflicting evidence** within its own analysis.

```json
{ "verified": false, "type": "contradictory", "confidence": 0.5,
  "evidence": [
    {"file": "types.ts", "line": 10, "snippet": "interface Foo { bar: string }"},
    {"file": "impl.ts", "line": 20, "snippet": "const foo: Foo = { bar: 123 }"}
  ],
  "reason": "Type declaration and implementation disagree on field type" }
```

Use when: evidence within a single engine's analysis conflicts (cross-engine contradictions are handled by the Orchestrator).

### Setting Confidence

| Scenario | Confidence | Rationale |
|:---------|:-----------|:----------|
| Compiler says pass/fail | 1.0 | Deterministic — no ambiguity |
| Linter rule match | 0.8–0.9 | Rules can have false positives |
| Pattern-based detection | 0.5–0.8 | Depends on pattern specificity |
| LLM-based judgment | 0.3–0.6 | Inherently probabilistic |
| Heuristic guess | 0.1–0.3 | Weak evidence |
| Cannot determine | 0.0 | Use with `type: "unknown"` |

**Important:** Your confidence is capped by your tier (see ECP Spec §4.4). If you're registered as `tier: "heuristic"`, the Orchestrator caps your confidence at 0.9 regardless of what you report.

### Computing Content Hashes

For A4 (Content-Addressed Truth) compliance:

```typescript
import { createHash } from "crypto";
import { readFileSync } from "fs";

function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}
```

```python
import hashlib
def compute_file_hash(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
```

**Why it matters:** When the Orchestrator stores your verdict as a Fact in the World Graph, it binds it to the content hash. If the file changes, the Fact is automatically invalidated. Without content hashes, stale verdicts can silently persist.

### Declaring Falsifiability

Tell the Orchestrator what would change your verdict:

```json
{
  "falsifiable_by": [
    "file:src/auth/login.ts:content-change",
    "file:src/auth/types.ts:content-change",
    "config:tsconfig.json:strictNullChecks-change"
  ]
}
```

This enables proactive re-verification when dependencies change.

---

## §5 Registration

### 5.1 Static (Config File)

Add to `vinyan.json`:

```json
{
  "oracles": {
    "my-security-scanner": {
      "enabled": true,
      "command": "python3 /path/to/security_scanner.py",
      "languages": ["typescript", "python"],
      "tier": "heuristic",
      "timeout_ms": 10000,
      "timeout_behavior": "warn"
    }
  }
}
```

| Field | Type | Required | Default | Description |
|:------|:-----|:---------|:--------|:-----------|
| `enabled` | boolean | No | `true` | Enable/disable this oracle |
| `command` | string | **Yes** (for external) | — | Shell command to spawn oracle |
| `languages` | string[] | No | — | Languages this oracle supports |
| `tier` | string | No | `"deterministic"` | Trust tier |
| `timeout_ms` | number | No | 30,000 | Per-invocation timeout |
| `timeout_behavior` | string | No | `"block"` | `"block"` = fail-closed, `"warn"` = skip and continue |

### 5.2 Dynamic (Programmatic)

From TypeScript code:

```typescript
import { registerOracle } from "@vinyan/oracle/registry";

registerOracle("my-security-scanner", {
  command: "python3 /path/to/security_scanner.py",
  languages: ["typescript", "python"],
  tier: "heuristic",
  timeout_ms: 10000,
});
```

Reference: `src/oracle/python/register.ts` for a real example.

### 5.3 Network (Future — ECP Level 2)

For remote engines connected via WebSocket:

```json
{
  "method": "ecp/register",
  "params": {
    "name": "cloud-security-scanner",
    "capabilities": {
      "patterns": ["security-audit", "cve-check", "dependency-vuln"],
      "languages": ["typescript", "python", "go", "rust"]
    },
    "tier": "heuristic",
    "transport": {
      "preferred": "websocket",
      "endpoint": "ws://scanner.internal:8080/ecp"
    }
  }
}
```

---

## §6 Testing Your Oracle

### Manual Testing

Pipe a hypothesis directly:

```bash
echo '{"target":"src/auth/login.ts","pattern":"symbol-exists","context":{"symbolName":"AuthService"},"workspace":"/project"}' | bun run my-oracle/index.ts
```

Expected output: one line of valid `OracleVerdict` JSON.

### Validation Checklist

Before registering, verify your oracle satisfies these properties:

| # | Property | Check |
|:--|:---------|:------|
| 1 | **Valid JSON output** | stdout is parseable JSON |
| 2 | **Required fields present** | `verified`, `evidence`, `fileHashes`, `duration_ms` |
| 3 | **Exit code 0** | Even when `verified: false` |
| 4 | **Evidence on success** | If `verified: true`, then `evidence.length > 0` |
| 5 | **Reason on failure** | If `verified: false`, then `reason` is set |
| 6 | **Confidence in range** | `0 <= confidence <= 1` |
| 7 | **Confidence within tier** | Confidence does not exceed tier ceiling |
| 8 | **Handles missing target** | Returns `type: "unknown"` if target file doesn't exist |
| 9 | **Respects timeout** | Completes within `timeout_ms` or exits cleanly |
| 10 | **No stdout pollution** | Only the verdict JSON goes to stdout (logs go to stderr) |

**Property 10 is critical:** Any logging, debug output, or progress messages MUST go to stderr. The runner parses all of stdout as JSON. Anything else will cause `PARSE_ERROR`.

### Writing Automated Tests

```typescript
import { describe, test, expect } from "bun:test";
import { runOracle } from "@vinyan/oracle/runner";

describe("my-security-scanner", () => {
  test("detects SQL injection", async () => {
    const verdict = await runOracle("my-security-scanner", {
      target: "tests/fixtures/sql-injection.ts",
      pattern: "security-audit",
      workspace: process.cwd(),
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.evidence.length).toBeGreaterThan(0);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("passes clean code", async () => {
    const verdict = await runOracle("my-security-scanner", {
      target: "tests/fixtures/clean-handler.ts",
      pattern: "security-audit",
      workspace: process.cwd(),
    });
    expect(verdict.verified).toBe(true);
  });

  test("returns unknown for unsupported pattern", async () => {
    const verdict = await runOracle("my-security-scanner", {
      target: "src/app.ts",
      pattern: "type-check",  // not supported by security scanner
      workspace: process.cwd(),
    });
    expect(verdict.type).toBe("unknown");
  });
});
```

---

## §7 Language-Specific Guides

### 7.1 TypeScript / Bun

**Recommended pattern** — standalone process entry point:

```typescript
// oracle/index.ts — the subprocess entry point
import { HypothesisTupleSchema } from "@vinyan/oracle/protocol";
import { buildVerdict } from "@vinyan/core";

const input = await Bun.stdin.text();
const hypothesis = HypothesisTupleSchema.parse(JSON.parse(input));
const start = performance.now();

// ... your verification logic ...

const verdict = buildVerdict({
  verified: true,
  evidence: [{ file: hypothesis.target, line: 1, snippet: "OK" }],
  fileHashes: {},
  duration_ms: Math.round(performance.now() - start),
});
process.stdout.write(JSON.stringify(verdict) + "\n");
```

**Key imports:**
- `HypothesisTupleSchema` — Zod schema for input validation (`src/oracle/protocol.ts`)
- `buildVerdict()` — Factory with correct defaults for `type` and `confidence` (`src/core/index.ts`)
- `OracleVerdictSchema` — Zod schema for output self-validation (optional but recommended)

**Registration:**
```typescript
// oracle/register.ts
import { registerOracle } from "@vinyan/oracle/registry";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerMyOracle(): void {
  registerOracle("my-oracle", {
    command: `bun run ${resolve(__dirname, "index.ts")}`,
    languages: ["typescript"],
    tier: "heuristic",
  });
}
```

Reference implementation: `src/oracle/python/` (despite the name, it's a TypeScript process that wraps Pyright).

### 7.2 Python

**Recommended pattern** — wrap an external tool:

```python
#!/usr/bin/env python3
"""ECP oracle wrapping an external tool (e.g., bandit for security scanning)."""
import json, sys, subprocess, hashlib, time

def compute_hash(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()

def main():
    hypothesis = json.loads(sys.stdin.readline())
    start = time.monotonic()

    # Run external tool
    result = subprocess.run(
        ["bandit", "-f", "json", hypothesis["target"]],
        capture_output=True, text=True, cwd=hypothesis["workspace"],
        timeout=30
    )

    duration_ms = round((time.monotonic() - start) * 1000)

    # Map tool output to OracleVerdict
    if result.returncode not in (0, 1):  # bandit: 0=clean, 1=issues found
        verdict = {
            "verified": False, "type": "unknown", "confidence": 0,
            "evidence": [], "fileHashes": {},
            "reason": f"Bandit crashed: {result.stderr[:500]}",
            "errorCode": "ORACLE_CRASH", "duration_ms": duration_ms,
        }
    else:
        findings = json.loads(result.stdout).get("results", [])
        file_hash = compute_hash(hypothesis["target"])
        evidence = [
            {"file": f["filename"], "line": f["line_number"],
             "snippet": f["issue_text"], "contentHash": file_hash}
            for f in findings if f["issue_severity"] in ("HIGH", "MEDIUM")
        ]
        verdict = {
            "verified": len(evidence) == 0,
            "type": "known",
            "confidence": 0.85,
            "evidence": evidence,
            "fileHashes": {hypothesis["target"]: file_hash},
            "reason": f"{len(evidence)} security issue(s) found" if evidence else None,
            "duration_ms": duration_ms,
        }

    print(json.dumps(verdict))

if __name__ == "__main__":
    main()
```

**Pydantic models** (optional, for validation):

```python
from pydantic import BaseModel
from typing import Optional

class HypothesisTuple(BaseModel):
    target: str
    pattern: str
    context: Optional[dict] = None
    workspace: str

class Evidence(BaseModel):
    file: str
    line: int
    snippet: str
    contentHash: Optional[str] = None

class OracleVerdict(BaseModel):
    verified: bool
    type: str = "known"
    confidence: float = 1.0
    evidence: list[Evidence]
    fileHashes: dict[str, str]
    duration_ms: int
    reason: Optional[str] = None
    errorCode: Optional[str] = None
    falsifiable_by: Optional[list[str]] = None
```

### 7.3 Go

```go
package main

import (
    "crypto/sha256"
    "encoding/json"
    "fmt"
    "os"
    "time"
)

type Hypothesis struct {
    Target    string                 `json:"target"`
    Pattern   string                 `json:"pattern"`
    Context   map[string]interface{} `json:"context,omitempty"`
    Workspace string                 `json:"workspace"`
}

type Evidence struct {
    File        string `json:"file"`
    Line        int    `json:"line"`
    Snippet     string `json:"snippet"`
    ContentHash string `json:"contentHash,omitempty"`
}

type Verdict struct {
    Verified   bool              `json:"verified"`
    Type       string            `json:"type"`
    Confidence float64           `json:"confidence"`
    Evidence   []Evidence        `json:"evidence"`
    FileHashes map[string]string `json:"fileHashes"`
    DurationMs int64             `json:"duration_ms"`
    Reason     string            `json:"reason,omitempty"`
}

func main() {
    start := time.Now()
    var h Hypothesis
    json.NewDecoder(os.Stdin).Decode(&h)

    content, err := os.ReadFile(h.Target)
    if err != nil {
        v := Verdict{Verified: false, Type: "unknown", Evidence: []Evidence{},
            FileHashes: map[string]string{}, DurationMs: time.Since(start).Milliseconds()}
        json.NewEncoder(os.Stdout).Encode(v)
        return
    }

    hash := fmt.Sprintf("%x", sha256.Sum256(content))
    // ... your verification logic ...
    v := Verdict{
        Verified: true, Type: "known", Confidence: 1.0,
        Evidence:   []Evidence{{File: h.Target, Line: 1, Snippet: "OK", ContentHash: hash}},
        FileHashes: map[string]string{h.Target: hash},
        DurationMs: time.Since(start).Milliseconds(),
    }
    json.NewEncoder(os.Stdout).Encode(v)
}
```

Register: `"command": "go run ./my-oracle"` or `"command": "./my-oracle-binary"` for compiled binary.

---

## §8 Advanced Topics

### Circuit Breaker Behavior

If your oracle fails 3 times consecutively, the Orchestrator's circuit breaker **opens** for 60 seconds. During this window:
- Your oracle is skipped for all hypotheses
- The Orchestrator returns `type: "unknown"` for hypotheses that would have been routed to you
- After 60s, the circuit enters **half-open**: one probe request is sent
- Success → circuit closes (normal operation). Failure → circuit stays open for another 60s.

**How to avoid tripping the circuit breaker:**
- Handle errors gracefully — return a verdict with `type: "unknown"`, don't crash
- Respect `timeout_ms` — if you're running long, exit cleanly before the timeout
- Log errors to stderr, not stdout (stdout pollution = PARSE_ERROR = failure)

### Timeout Handling

The Orchestrator kills your process after `timeout_ms` (default: 30s). If you know your analysis might be slow:

1. Set a generous `timeout_ms` in your registration
2. Implement internal timeouts shorter than the Orchestrator's
3. Return a partial verdict with `type: "uncertain"` if you time out internally

```python
import signal

def timeout_handler(signum, frame):
    verdict = {"verified": False, "type": "uncertain", "confidence": 0.2,
               "evidence": [], "fileHashes": {},
               "reason": "Analysis timed out internally", "duration_ms": 29000}
    print(json.dumps(verdict))
    sys.exit(0)  # Exit 0! Not a crash.

signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(29)  # Internal timeout < orchestrator's 30s
```

### Wrapping External Tools

The most common oracle pattern: wrap an existing CLI tool and map its output to `OracleVerdict`.

**Pattern:**
1. Parse `HypothesisTuple` from stdin
2. Spawn the external tool with appropriate arguments
3. Parse the tool's output (JSON, text, exit code)
4. Map to `OracleVerdict` fields
5. Write verdict to stdout

**Reference:** `src/oracle/python/pyright-mapper.ts` — maps Pyright's JSON output to `OracleVerdict`:
- Pyright errors → `evidence[]` entries
- Exit code 1 (type errors) → `verified: false` (NOT a crash)
- Exit code 0 → `verified: true`
- No stdout → `errorCode: "ORACLE_CRASH"`

### Stateful Oracles (Future — Network Transport)

Stdio oracles are stateless: one process per hypothesis. Network oracles (WebSocket) can maintain state across invocations:

- Cache parsed ASTs between calls
- Maintain incremental analysis state
- Track hypothesis history for better predictions

Stateful oracles register via WebSocket (`ecp/register`) and receive hypotheses as messages instead of process invocations.

---

## Appendix: Reference Implementation Walkthrough

The `src/oracle/python/` directory is the canonical example of a non-TypeScript oracle:

| File | Purpose |
|:-----|:--------|
| `index.ts` | Subprocess entry point — reads stdin, spawns pyright, writes stdout |
| `pyright-mapper.ts` | Maps Pyright JSON output → `OracleVerdict` |
| `register.ts` | Registers oracle in dynamic registry with `command`, `languages`, `tier` |

**Key patterns demonstrated:**
1. External tool wrapping (Pyright CLI → JSON → Verdict)
2. Zod validation of both input (`HypothesisTupleSchema`) and tool output (`PyrightOutputSchema`)
3. Correct exit code handling (Pyright exits 1 on type errors — that's not a crash)
4. Timeout handling with `Promise.race` and `proc.kill()`
5. Dynamic registration via `registerOracle()`
