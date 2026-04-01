/**
 * LLM-based TestGenerator implementation — generative verification (§17.7).
 *
 * Generates targeted test cases for proposed mutations via an LLM call,
 * then runs them to detect logic errors that structural oracles miss.
 *
 * Axiom: A1 — the test generator is a separate LLM call from the code generator.
 * Axiom: A4 — failures produce content-addressed evidence.
 * Axiom: A5 — tier = probabilistic (LLM-generated tests, deterministic execution).
 *
 * Activation: L2+ routing levels, after Critic passes.
 */
import { createHash } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence } from '../../core/types.ts';
import type { WorkerProposal } from '../critic/critic-engine.ts';
import type { LLMProvider, LLMRequest, PerceptualHierarchy } from '../types.ts';
import type { TestGenerator, TestGenResult } from './test-generator.ts';

interface GeneratedTest {
  name: string;
  code: string;
  targetFunction: string;
  category: 'happy-path' | 'edge-case' | 'regression' | 'acceptance';
}

export class LLMTestGeneratorImpl implements TestGenerator {
  constructor(
    private readonly provider: LLMProvider,
    private readonly workspace?: string,
  ) {}

  async generateAndRun(proposal: WorkerProposal, perception: PerceptualHierarchy): Promise<TestGenResult> {
    // Step 1: Generate tests via LLM
    const request: LLMRequest = {
      systemPrompt: buildTestGenSystemPrompt(),
      userPrompt: buildTestGenUserPrompt(proposal, perception),
      maxTokens: 4096,
      temperature: 0.2,
    };

    let response;
    try {
      response = await this.provider.generate(request);
    } catch {
      return emptyResult();
    }

    const tokensUsed = response.tokensUsed;
    const tests = parseGeneratedTests(response.content);
    if (tests.length === 0) {
      return { generatedTests: [], results: [], failures: [], tokensUsed };
    }

    // Step 2: Write tests to a temporary file and run them
    const workspace = this.workspace ?? process.cwd();
    const testFile = join(workspace, `.vinyan-gen-test-${Date.now()}.test.ts`);
    const testCode = assembleTestFile(tests, proposal);

    try {
      writeFileSync(testFile, testCode);

      // Run generated tests via Bun test runner (deterministic oracle — A1 compliance)
      const proc = Bun.spawn(['bun', 'test', testFile, '--timeout', '10000'], {
        cwd: workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NODE_ENV: 'test' },
      });

      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const exitCode = await proc.exited;

      const results = parseTestResults(tests, exitCode, stdout + stderr);
      const failures = buildFailureEvidence(results, proposal);

      return { generatedTests: tests, results, failures, tokensUsed };
    } finally {
      // Clean up temporary test file
      try {
        if (existsSync(testFile)) unlinkSync(testFile);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildTestGenSystemPrompt(): string {
  return `[ROLE]
You are a test generation engine in the Vinyan Epistemic Nervous System.
You generate targeted test cases for code mutations proposed by a worker.
You did NOT write the code — your tests VERIFY the worker's proposal.

[OUTPUT FORMAT]
Respond with a JSON array of test objects:
[
  {
    "name": "descriptive test name",
    "code": "test body code (single expect statement preferred)",
    "targetFunction": "name of function being tested",
    "category": "happy-path" | "edge-case" | "regression" | "acceptance"
  }
]

[RULES]
- Generate 2-5 focused tests per mutation
- Prefer edge cases and boundary conditions over happy paths
- Each test should be self-contained (no shared state)
- Use expect() assertions (Bun test runner compatible)
- Import the module under test using relative paths from the test file location
- Do NOT use mocks — test real behavior
- Respond ONLY with the JSON array, no markdown fences or other text`;
}

function buildTestGenUserPrompt(proposal: WorkerProposal, perception: PerceptualHierarchy): string {
  const sections: string[] = [];

  const mutationSummary = proposal.mutations.map((m) => `--- ${m.file} ---\n${m.content}`).join('\n\n');
  sections.push(`[PROPOSED CODE]\n${mutationSummary}`);

  if (proposal.approach) {
    sections.push(`[APPROACH]\n${proposal.approach}`);
  }

  sections.push(`[CONTEXT]
Target: ${perception.taskTarget.file} — ${perception.taskTarget.description}
Blast radius: ${perception.dependencyCone.transitiveBlastRadius} files`);

  if (perception.diagnostics.failingTests.length > 0) {
    sections.push(`[KNOWN FAILING TESTS]\n${perception.diagnostics.failingTests.join('\n')}`);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseGeneratedTests(content: string): GeneratedTest[] {
  try {
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]!.trim();
    }

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    const validCategories = new Set(['happy-path', 'edge-case', 'regression', 'acceptance']);
    const tests: GeneratedTest[] = [];

    for (const item of parsed) {
      if (
        typeof item.name === 'string' &&
        typeof item.code === 'string' &&
        typeof item.targetFunction === 'string' &&
        validCategories.has(item.category)
      ) {
        tests.push({
          name: item.name,
          code: item.code,
          targetFunction: item.targetFunction,
          category: item.category,
        });
      }
    }

    return tests;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test assembly and execution
// ---------------------------------------------------------------------------

function assembleTestFile(tests: GeneratedTest[], proposal: WorkerProposal): string {
  const imports = new Set<string>();
  for (const m of proposal.mutations) {
    // Generate relative import from test file (workspace root) to the mutated file
    const importPath = m.file.startsWith('./') ? m.file : `./${m.file}`;
    imports.add(importPath);
  }

  const importLines = Array.from(imports)
    .map((p) => `import "${p}";`)
    .join('\n');

  const testCases = tests
    .map((t) => `  test("${t.name.replace(/"/g, '\\"')}", () => {\n    ${t.code}\n  });`)
    .join('\n\n');

  return `// Auto-generated by Vinyan TestGenerator — ephemeral verification tests
import { describe, test, expect } from "bun:test";
${importLines}

describe("Vinyan Generated Tests", () => {
${testCases}
});
`;
}

function parseTestResults(
  tests: GeneratedTest[],
  exitCode: number,
  output: string,
): Array<{ name: string; passed: boolean; error?: string; durationMs: number }> {
  // If all tests passed (exit code 0), mark all as passed
  if (exitCode === 0) {
    return tests.map((t) => ({ name: t.name, passed: true, durationMs: 0 }));
  }

  // Parse individual test results from output
  return tests.map((t) => {
    // Check if test name appears in failure output
    const escapedName = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const failPattern = new RegExp(`${escapedName}.*(?:fail|error|✗|×)`, 'i');
    const failed = failPattern.test(output);

    // Extract error message if failed
    let error: string | undefined;
    if (failed) {
      const errorMatch = output.match(new RegExp(`${escapedName}[\\s\\S]*?(Error:.*?)(?:\\n\\n|$)`));
      error = errorMatch?.[1] ?? 'Test failed';
    }

    return { name: t.name, passed: !failed, error, durationMs: 0 };
  });
}

function buildFailureEvidence(
  results: Array<{ name: string; passed: boolean; error?: string }>,
  proposal: WorkerProposal,
): Array<{ name: string; error: string; evidence: Evidence }> {
  return results
    .filter((r) => !r.passed && r.error)
    .map((r) => {
      const targetFile = proposal.mutations[0]?.file ?? 'unknown';
      const targetContent = proposal.mutations[0]?.content ?? '';
      return {
        name: r.name,
        error: r.error!,
        evidence: {
          file: targetFile,
          line: 1,
          snippet: `Test "${r.name}" failed: ${r.error}`,
          contentHash: createHash('sha256').update(targetContent).digest('hex'),
        },
      };
    });
}

function emptyResult(): TestGenResult {
  return {
    generatedTests: [],
    results: [],
    failures: [],
    tokensUsed: { input: 0, output: 0 },
  };
}
