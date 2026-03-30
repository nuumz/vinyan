import { createHash } from "crypto";
import { readFileSync } from "fs";
import type { HypothesisTuple, OracleVerdict, Evidence } from "../../core/types.ts";
import { buildVerdict } from "../../core/index.ts";

/**
 * Type Verifier — spawns `tsc --noEmit` on the workspace and parses diagnostic output.
 * verified = zero diagnostics for the target file(s).
 */

interface TscDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Parse tsc diagnostic output format: file(line,col): error TSxxxx: message */
function parseTscOutput(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Match: path/to/file.ts(line,col): error TS1234: message
    // Path may contain ../  and spaces
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (match) {
      diagnostics.push({
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        col: parseInt(match[3]!, 10),
        code: match[4]!,
        message: match[5]!,
      });
    }
  }

  return diagnostics;
}

/** Resolve path to tsc binary from this package's node_modules. */
function resolveTscPath(): string {
  // Use the tsc installed in our own node_modules, not bunx (which depends on CWD's .npmrc)
  const localTsc = new URL("../../../node_modules/.bin/tsc", import.meta.url).pathname;
  return localTsc;
}

/** Run tsc --noEmit and return diagnostics. */
async function runTsc(workspace: string, target?: string): Promise<{ diagnostics: TscDiagnostic[]; exitCode: number }> {
  const args = ["--noEmit", "--pretty", "false", "--project", workspace];

  const proc = Bun.spawn([resolveTscPath(), ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  return { diagnostics: parseTscOutput(stdout), exitCode };
}

export async function verify(hypothesis: HypothesisTuple): Promise<OracleVerdict> {
  const startTime = performance.now();
  const workspace = hypothesis.workspace;
  const target = hypothesis.target;

  try {
    const { diagnostics } = await runTsc(workspace);

    // Filter diagnostics to target file if specified
    const targetDiags = target
      ? diagnostics.filter((d) => d.file.includes(target) || d.file.endsWith(target))
      : diagnostics;

    const evidence: Evidence[] = targetDiags.map((d) => ({
      file: d.file,
      line: d.line,
      snippet: `${d.code}: ${d.message}`,
    }));

    // Compute file hash if target exists as a file
    const fileHashes: Record<string, string> = {};
    try {
      const content = readFileSync(target);
      fileHashes[target] = createHash("sha256").update(content).digest("hex");
    } catch {
      // target might be a symbol path, not a file — that's fine
    }

    return buildVerdict({
      verified: targetDiags.length === 0,
      evidence,
      fileHashes,
      reason: targetDiags.length > 0 ? `${targetDiags.length} type error(s) found` : undefined,
      errorCode: targetDiags.length > 0 ? "TYPE_MISMATCH" : undefined,
      duration_ms: Math.round(performance.now() - startTime),
    });
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Type verification failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "ORACLE_CRASH",
      duration_ms: Math.round(performance.now() - startTime),
    });
  }
}
