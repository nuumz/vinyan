/**
 * Perception Assembler — builds PerceptualHierarchy per routing level.
 *
 * Queries dep-oracle for dependency cone, World Graph for verified facts,
 * and tsc for diagnostics. Filters depth by routing level.
 *
 * Source of truth: vinyan-tdd.md §16.2 (Perceive step), arch D8
 */
import { resolve, relative } from "path";
import { buildDependencyGraph, computeBlastRadius } from "../oracle/dep/dep-analyzer.ts";
import type { WorldGraph } from "../world-graph/world-graph.ts";
import type { PerceptualHierarchy, RoutingLevel } from "./types.ts";
import type { PerceptionAssembler } from "./core-loop.ts";
import type { TaskInput } from "./types.ts";

export interface PerceptionAssemblerConfig {
  workspace: string;
  worldGraph?: WorldGraph;
  availableTools?: string[];
}

export class PerceptionAssemblerImpl implements PerceptionAssembler {
  private workspace: string;
  private worldGraph?: WorldGraph;
  private availableTools: string[];

  constructor(config: PerceptionAssemblerConfig) {
    this.workspace = config.workspace;
    this.worldGraph = config.worldGraph;
    this.availableTools = config.availableTools ?? [
      "file_read", "file_write", "file_edit", "directory_list",
      "search_grep", "shell_exec", "git_status", "git_diff",
    ];
  }

  async assemble(input: TaskInput, level: RoutingLevel): Promise<PerceptualHierarchy> {
    const targetFile = input.targetFiles?.[0] ?? "";
    const targetAbsolute = targetFile ? resolve(this.workspace, targetFile) : "";

    // Build dependency cone
    const { directImportees, directImporters, transitiveImporters, transitiveBlastRadius, affectedTestFiles } =
      this.buildDependencyCone(targetAbsolute, level);

    // Query World Graph for verified facts
    const verifiedFacts = this.queryVerifiedFacts(
      [targetFile, ...directImporters, ...directImportees],
    );

    // Run diagnostics
    const diagnostics = await this.runDiagnostics();

    return {
      taskTarget: {
        file: targetFile,
        symbol: undefined,
        description: input.goal,
      },
      dependencyCone: {
        directImporters,
        directImportees,
        transitiveBlastRadius,
        transitiveImporters: level >= 2 ? transitiveImporters : undefined,
        affectedTestFiles: level >= 2 ? affectedTestFiles : undefined,
      },
      diagnostics,
      verifiedFacts,
      runtime: {
        nodeVersion: process.version,
        os: process.platform,
        availableTools: this.availableTools,
      },
    };
  }

  private buildDependencyCone(targetAbsolute: string, level: RoutingLevel) {
    if (!targetAbsolute) {
      return {
        directImportees: [] as string[],
        directImporters: [] as string[],
        transitiveImporters: [] as string[],
        transitiveBlastRadius: 0,
        affectedTestFiles: [] as string[],
      };
    }

    try {
      const graph = buildDependencyGraph(this.workspace);

      // Forward deps: what the target imports
      const forwardDeps = graph.get(targetAbsolute) ?? new Set<string>();
      const directImportees = Array.from(forwardDeps).map(f => relative(this.workspace, f));

      // Reverse deps: what depends on the target
      const allDependents = computeBlastRadius(targetAbsolute, graph);
      const allDependentsRel = allDependents.map(f => relative(this.workspace, f));

      // Direct importers: files that directly import target (depth 1 only)
      const directImporters: string[] = [];
      for (const [file, deps] of graph) {
        if (deps.has(targetAbsolute) && file !== targetAbsolute) {
          directImporters.push(relative(this.workspace, file));
        }
      }

      // Filter test files from the full blast radius
      const testPattern = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
      const affectedTestFiles = allDependentsRel.filter(f => testPattern.test(f));

      return {
        directImportees,
        directImporters,
        transitiveImporters: allDependentsRel,
        transitiveBlastRadius: allDependents.length,
        affectedTestFiles,
      };
    } catch {
      return {
        directImportees: [] as string[],
        directImporters: [] as string[],
        transitiveImporters: [] as string[],
        transitiveBlastRadius: 0,
        affectedTestFiles: [] as string[],
      };
    }
  }

  private queryVerifiedFacts(files: string[]): PerceptualHierarchy["verifiedFacts"] {
    if (!this.worldGraph) return [];

    const facts: PerceptualHierarchy["verifiedFacts"] = [];
    for (const file of files) {
      if (!file) continue;
      try {
        const fileFacts = this.worldGraph.queryFacts(file);
        for (const f of fileFacts) {
          facts.push({
            target: f.target,
            pattern: f.pattern,
            verified_at: f.verified_at,
            hash: f.file_hash,
          });
        }
      } catch {
        // WorldGraph query failed — skip this file
      }
    }
    return facts;
  }

  private async runDiagnostics(): Promise<PerceptualHierarchy["diagnostics"]> {
    const empty = { lintWarnings: [], typeErrors: [], failingTests: [] };
    try {
      const proc = Bun.spawn(["tsc", "--noEmit", "--pretty", "false"], {
        cwd: this.workspace,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutPromise = new Promise<"timeout">(r => setTimeout(() => r("timeout"), 10_000));
      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout;
      })();

      const result = await Promise.race([processPromise, timeoutPromise]);
      if (result === "timeout") {
        proc.kill();
        return empty;
      }

      // Parse tsc output: "file(line,col): error TS1234: message"
      const typeErrors: PerceptualHierarchy["diagnostics"]["typeErrors"] = [];
      for (const line of result.split("\n")) {
        const match = line.match(/^(.+)\((\d+),\d+\):\s+error\s+TS\d+:\s+(.+)$/);
        if (match) {
          typeErrors.push({ file: match[1]!, line: parseInt(match[2]!, 10), message: match[3]! });
        }
      }

      return { lintWarnings: [], typeErrors, failingTests: [] };
    } catch {
      return empty;
    }
  }
}
