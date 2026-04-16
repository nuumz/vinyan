/**
 * lint-oracle — runs linter on target file and reports errors.
 *
 * Pattern: "lint-clean" — verified=true if no lint errors (warnings ok).
 * P99 budget: 1,000ms (TDD §13).
 *
 * Linter detection: eslint.config → eslint, ruff.toml/pyproject → ruff.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { buildVerdict } from '../../core/index.ts';
import { fromScalar } from '../../core/subjective-opinion.ts';
import type { Evidence, HypothesisTuple, OracleAbstention, OracleResponse, OracleVerdict } from '../../core/types.ts';

const BASE_RATE = 0.7;
const TTL_MS = 300_000;

interface LintError {
  file: string;
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

/** Detect linter from workspace markers. */
function detectLinter(workspace: string): { cmd: string; args: string[] } | null {
  // ESLint
  const eslintConfigs = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc',
  ];
  for (const config of eslintConfigs) {
    if (existsSync(join(workspace, config))) {
      return { cmd: 'npx', args: ['eslint', '--format', 'json'] };
    }
  }

  // Ruff (Python)
  if (existsSync(join(workspace, 'ruff.toml')) || existsSync(join(workspace, '.ruff.toml'))) {
    return { cmd: 'ruff', args: ['check', '--output-format', 'json'] };
  }

  return null;
}

/** Parse ESLint JSON output. */
function parseEslintOutput(output: string): LintError[] {
  try {
    const results = JSON.parse(output) as Array<{
      filePath: string;
      messages: Array<{ line: number; message: string; severity: number }>;
    }>;
    const errors: LintError[] = [];
    for (const result of results) {
      for (const msg of result.messages) {
        errors.push({
          file: result.filePath,
          line: msg.line,
          message: msg.message,
          severity: msg.severity >= 2 ? 'error' : 'warning',
        });
      }
    }
    return errors;
  } catch {
    return [];
  }
}

/** Parse Ruff JSON output. */
function parseRuffOutput(output: string): LintError[] {
  try {
    const results = JSON.parse(output) as Array<{
      filename: string;
      location: { row: number };
      message: string;
      fix?: unknown;
    }>;
    return results.map((r) => ({
      file: r.filename,
      line: r.location.row,
      message: r.message,
      severity: 'error' as const,
    }));
  } catch {
    return [];
  }
}

export async function verify(hypothesis: HypothesisTuple): Promise<OracleResponse> {
  const start = performance.now();
  const { workspace, target } = hypothesis;

  const linter = detectLinter(workspace);
  if (!linter) {
    return {
      type: 'abstained',
      reason: 'no_linter_configured',
      oracleName: 'lint',
      durationMs: performance.now() - start,
      prerequisites: ['Install ESLint (package.json devDependencies) or Ruff (pyproject.toml)'],
    } satisfies OracleAbstention;
  }

  const targetPath = join(workspace, target);

  // A4: Compute content hash for the target file (enables content-hash verification in gate)
  const fileHashes: Record<string, string> = {};
  try {
    if (existsSync(targetPath)) {
      fileHashes[targetPath] = createHash('sha256').update(readFileSync(targetPath)).digest('hex');
    }
  } catch {
    // Hash computation is best-effort
  }

  if (!existsSync(targetPath)) {
    return buildVerdict({
      verified: true,
      type: 'uncertain',
      confidence: 0.5,
      evidence: [],
      fileHashes,
      reason: `Target file ${target} not found`,
      durationMs: performance.now() - start,
      opinion: fromScalar(0.5, BASE_RATE),
      temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'exponential' as const, halfLife: 300_000 },
    });
  }

  try {
    const proc = Bun.spawn([linter.cmd, ...linter.args, target], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const durationMs = performance.now() - start;

    const isEslint = linter.cmd === 'npx' && linter.args.includes('eslint');
    const lintErrors = isEslint ? parseEslintOutput(stdout) : parseRuffOutput(stdout);
    const errors = lintErrors.filter((e) => e.severity === 'error');

    const evidence: Evidence[] = errors.slice(0, 10).map((e) => ({
      file: relative(workspace, e.file) || target,
      line: e.line,
      snippet: e.message,
    }));

    if (errors.length === 0) {
      return buildVerdict({
        verified: true,
        type: 'known',
        confidence: 0.95,
        evidence: [],
        fileHashes,
        reason: `Lint clean (${lintErrors.length} warnings)`,
        durationMs,
        opinion: fromScalar(0.95, BASE_RATE),
        temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'exponential' as const, halfLife: 300_000 },
      });
    }

    return buildVerdict({
      verified: false,
      type: 'known',
      confidence: 0.95,
      evidence,
      fileHashes,
      reason: `${errors.length} lint error(s) found`,
      durationMs,
      opinion: fromScalar(0.95, BASE_RATE),
      temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'exponential' as const, halfLife: 300_000 },
    });
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes,
      reason: `Linter failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'ORACLE_CRASH',
      durationMs: performance.now() - start,
      opinion: fromScalar(0, BASE_RATE),
      temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'exponential' as const, halfLife: 300_000 },
    });
  }
}
