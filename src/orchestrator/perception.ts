/**
 * Perception Assembler — builds PerceptualHierarchy per routing level.
 *
 * Queries dep-oracle for dependency cone, World Graph for verified facts,
 * and tsc for diagnostics. Filters depth by routing level.
 *
 * Source of truth: spec/tdd.md §16.2 (Perceive step), arch D8
 */
import { relative, resolve } from 'path';
import { buildDependencyGraph, computeBlastRadius } from '../oracle/dep/dep-analyzer.ts';
import type { CausalEdgeExtractor } from '../oracle/dep/causal-edge-extractor.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import type { PerceptionAssembler } from './core-loop.ts';
import type { PerceptualHierarchy, RoutingLevel, TaskInput } from './types.ts';

export interface PerceptionAssemblerConfig {
  workspace: string;
  worldGraph?: WorldGraph;
  availableTools?: string[];
  causalEdgeExtractor?: CausalEdgeExtractor;
}

export class PerceptionAssemblerImpl implements PerceptionAssembler {
  private workspace: string;
  private worldGraph?: WorldGraph;
  private availableTools: string[];
  private causalEdgeExtractor?: CausalEdgeExtractor;

  constructor(config: PerceptionAssemblerConfig) {
    this.workspace = config.workspace;
    this.worldGraph = config.worldGraph;
    this.causalEdgeExtractor = config.causalEdgeExtractor;
    this.availableTools = config.availableTools ?? [
      'file_read',
      'file_write',
      'file_edit',
      'directory_list',
      'search_grep',
      'shell_exec',
      'git_status',
      'git_diff',
    ];
  }

  async assemble(input: TaskInput, level: RoutingLevel): Promise<PerceptualHierarchy> {
    const targetFiles = input.targetFiles ?? [];
    const primaryFile = targetFiles[0] ?? '';

    // Build dependency cones for ALL target files and merge
    const allDirectImporters: string[] = [];
    const allDirectImportees: string[] = [];
    const allTransitiveImporters: string[] = [];
    let maxBlastRadius = 0;
    const allTestFiles: string[] = [];

    for (const tf of targetFiles) {
      const abs = tf ? resolve(this.workspace, tf) : '';
      if (!abs) continue;
      const cone = this.buildDependencyCone(abs, level);
      allDirectImporters.push(...cone.directImporters);
      allDirectImportees.push(...cone.directImportees);
      allTransitiveImporters.push(...(cone.transitiveImporters ?? []));
      maxBlastRadius = Math.max(maxBlastRadius, cone.transitiveBlastRadius);
      allTestFiles.push(...(cone.affectedTestFiles ?? []));
    }

    // Deduplicate
    const directImporters = [...new Set(allDirectImporters)];
    const directImportees = [...new Set(allDirectImportees)];
    const transitiveImporters = [...new Set(allTransitiveImporters)];
    const affectedTestFiles = [...new Set(allTestFiles)];

    // Query World Graph for verified facts from all files in merged cone
    const factTargets = [...new Set([...targetFiles, ...directImporters, ...directImportees])];
    const verifiedFacts = this.queryVerifiedFacts(factTargets);

    // Run diagnostics
    const diagnostics = await this.runDiagnostics();

    // Extract causal edges for target files (FP-B)
    let causalEdges: PerceptualHierarchy['causalEdges'];
    if (this.causalEdgeExtractor && targetFiles.length > 0) {
      try {
        causalEdges = await this.causalEdgeExtractor.extractEdges(targetFiles, this.workspace);
        // Store extracted edges in World Graph for future queries
        if (this.worldGraph && causalEdges && causalEdges.length > 0) {
          try {
            this.worldGraph.storeCausalEdgesTyped(causalEdges);
          } catch { /* best-effort persist */ }
        }
      } catch { /* causal extraction failed — proceed without */ }
    }

    return {
      taskTarget: {
        file: primaryFile,
        symbol: undefined,
        description: input.goal,
      },
      dependencyCone: {
        directImporters,
        directImportees,
        transitiveBlastRadius: maxBlastRadius,
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
      causalEdges,
    };
  }

  private buildDependencyCone(targetAbsolute: string, _level: RoutingLevel) {
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

      // Persist dependency edges to World Graph for bounded cascade
      if (this.worldGraph) {
        const edges: Array<{ from: string; to: string }> = [];
        for (const [fromFile, deps] of graph.entries()) {
          for (const toFile of deps) {
            edges.push({ from: fromFile, to: toFile });
          }
        }
        try {
          this.worldGraph.storeEdges(edges);
        } catch {
          /* best-effort */
        }
      }

      // Forward deps: what the target imports
      const forwardDeps = graph.get(targetAbsolute) ?? new Set<string>();
      const directImportees = Array.from(forwardDeps).map((f) => relative(this.workspace, f));

      // Reverse deps: what depends on the target
      const allDependents = computeBlastRadius(targetAbsolute, graph);
      const allDependentsRel = allDependents.map((f) => relative(this.workspace, f));

      // Direct importers: files that directly import target (depth 1 only)
      const directImporters: string[] = [];
      for (const [file, deps] of graph) {
        if (deps.has(targetAbsolute) && file !== targetAbsolute) {
          directImporters.push(relative(this.workspace, file));
        }
      }

      // Filter test files from the full blast radius
      const testPattern = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
      const affectedTestFiles = allDependentsRel.filter((f) => testPattern.test(f));

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

  private queryVerifiedFacts(files: string[]): PerceptualHierarchy['verifiedFacts'] {
    if (!this.worldGraph) return [];

    const facts: PerceptualHierarchy['verifiedFacts'] = [];
    for (const file of files) {
      if (!file) continue;
      try {
        const fileFacts = this.worldGraph.queryFacts(file);
        for (const f of fileFacts) {
          facts.push({
            target: f.target,
            pattern: f.pattern,
            verified_at: f.verifiedAt,
            hash: f.fileHash,
          });
        }
      } catch {
        // WorldGraph query failed — skip this file
      }
    }
    return facts;
  }

  private async runDiagnostics(): Promise<PerceptualHierarchy['diagnostics']> {
    const empty = { lintWarnings: [], typeErrors: [], failingTests: [] };
    try {
      const proc = Bun.spawn(['tsc', '--noEmit', '--pretty', 'false'], {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000));
      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout;
      })();

      const result = await Promise.race([processPromise, timeoutPromise]);
      if (result === 'timeout') {
        proc.kill();
        return empty;
      }

      // Parse tsc output: "file(line,col): error TS1234: message"
      const typeErrors: PerceptualHierarchy['diagnostics']['typeErrors'] = [];
      for (const line of result.split('\n')) {
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
