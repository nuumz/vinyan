/**
 * Perception Assembler — builds PerceptualHierarchy per routing level.
 *
 * Queries dep-oracle for dependency cone, World Graph for verified facts,
 * and tsc for diagnostics. Filters depth by routing level.
 *
 * Source of truth: spec/tdd.md §16.2 (Perceive step), arch D8
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'path';
import { buildDependencyGraph, computeBlastRadius } from '../oracle/dep/dep-analyzer.ts';
import type { CausalEdgeExtractor } from '../oracle/dep/causal-edge-extractor.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import type { PerceptionAssembler } from './core-loop.ts';
import { detectFrameworkMarkers } from './task-fingerprint.ts';
import type { PerceptualHierarchy, RoutingLevel, TaskInput, TaskUnderstanding } from './types.ts';

export interface PerceptionAssemblerConfig {
  workspace: string;
  worldGraph?: WorldGraph;
  availableTools?: string[];
  causalEdgeExtractor?: CausalEdgeExtractor;
  /** Gap 3A: Optional pre-computed task understanding for symbol population. */
  taskUnderstanding?: TaskUnderstanding;
  /** Token budget for reading file contents (~3 chars per token). */
  maxTotalChars?: number;
  /** Max chars per individual file. */
  maxPerFileChars?: number;
}

export class PerceptionAssemblerImpl implements PerceptionAssembler {
  private workspace: string;
  private worldGraph?: WorldGraph;
  private availableTools: string[];
  private causalEdgeExtractor?: CausalEdgeExtractor;
  private maxTotalChars: number;
  private maxPerFileChars: number;

  constructor(config: PerceptionAssemblerConfig) {
    this.workspace = config.workspace;
    this.worldGraph = config.worldGraph;
    this.causalEdgeExtractor = config.causalEdgeExtractor;
    this.maxTotalChars = config.maxTotalChars ?? 6000; // ~2000 tokens at 3 chars/token
    this.maxPerFileChars = config.maxPerFileChars ?? 4000;
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

  async assemble(input: TaskInput, level: RoutingLevel, understanding?: TaskUnderstanding): Promise<PerceptualHierarchy> {
    // Gap 7A+2A: Only skip perception for reasoning tasks WITHOUT target files.
    // Reasoning tasks with targetFiles (analysis, investigation) get full structural perception.
    if (input.taskType === 'reasoning' && !(input.targetFiles?.length)) {
      return {
        taskTarget: { file: '', symbol: undefined, description: input.goal },
        dependencyCone: {
          directImporters: [],
          directImportees: [],
          transitiveBlastRadius: 0,
        },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: {
          nodeVersion: process.version,
          os: process.platform,
          availableTools: this.availableTools,
        },
      };
    }

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
    const verifiedFacts = this.queryVerifiedFacts(factTargets, level);

    // Run diagnostics — only at L2+ (analytical); L0/L1 don't have budget to act on type errors
    const diagnostics = level >= 2 ? await this.runDiagnostics() : { lintWarnings: [], typeErrors: [], failingTests: [] };

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

    // Gap 3A: Populate symbol from TaskUnderstanding (extracted from goal text)
    // Gap 3B: Detect framework markers from dependency cone
    const perception: PerceptualHierarchy = {
      taskTarget: {
        file: primaryFile,
        symbol: understanding?.targetSymbol,
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

    // Gap 3B: Populate framework markers from import paths
    const frameworks = detectFrameworkMarkers(perception);
    if (frameworks.length > 0) {
      perception.frameworkMarkers = frameworks;
    }

    // Gap 3C: Read target file contents for L1+ (token-budgeted, priority-tiered preview)
    if (level >= 1 && targetFiles.length > 0) {
      const fileContents = this.readFileContents(targetFiles, directImporters, affectedTestFiles);
      if (fileContents) perception.fileContents = fileContents;
    }

    return perception;
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

  /**
   * Gap 3C: Read file contents with a configurable token budget and priority tiers.
   * Priority: P0 target files (60%) → P1 direct importers (25%) → P2 test files (15%).
   * Unused budget flows down: if P0 doesn't exhaust its allocation, P1 gets more.
   */
  private readFileContents(
    targetFiles: string[],
    importerFiles: string[] = [],
    testFiles: string[] = [],
  ): PerceptualHierarchy['fileContents'] | undefined {
    const totalBudget = this.maxTotalChars;
    const maxPerFile = this.maxPerFileChars;

    // Priority-tiered allocation (unused budget flows to next tier)
    const P0_RATIO = 0.6;
    const P1_RATIO = 0.25;
    // P2 gets remainder (0.15 base + any unused from P0/P1)

    let totalChars = 0;
    const contents: Array<{ file: string; content: string; truncated: boolean }> = [];
    const seen = new Set<string>();

    const readTier = (files: string[], tierBudget: number) => {
      let tierChars = 0;
      for (const relPath of files) {
        if (seen.has(relPath)) continue; // Deduplicate across tiers
        if (totalChars >= totalBudget) break;
        if (tierChars >= tierBudget) break;

        seen.add(relPath);
        const absPath = resolve(this.workspace, relPath);
        try {
          if (!existsSync(absPath)) continue;
          const raw = readFileSync(absPath, 'utf-8');
          if (!raw) continue;
          const budget = Math.min(maxPerFile, tierBudget - tierChars, totalBudget - totalChars);
          if (budget <= 0) break;
          const truncated = raw.length > budget;
          const content = truncated ? raw.slice(0, budget) : raw;
          contents.push({ file: relPath, content, truncated });
          tierChars += content.length;
          totalChars += content.length;
        } catch {
          // File read failed — skip
        }
      }
      return tierChars;
    };

    // P0: Target files — most important, get 60% of budget
    const p0Budget = Math.floor(totalBudget * P0_RATIO);
    const p0Used = readTier(targetFiles, p0Budget);
    const p0Remaining = p0Budget - p0Used;

    // P1: Direct importers — 25% base + unused from P0
    const p1Budget = Math.floor(totalBudget * P1_RATIO) + p0Remaining;
    const p1Used = readTier(importerFiles, p1Budget);
    const p1Remaining = p1Budget - p1Used;

    // P2: Test files — remainder (15% base + any unused from P0/P1)
    const p2Budget = (totalBudget - totalChars); // All remaining budget
    readTier(testFiles, p2Budget);

    return contents.length > 0 ? contents : undefined;
  }

  private queryVerifiedFacts(files: string[], routingLevel?: number): PerceptualHierarchy['verifiedFacts'] {
    if (!this.worldGraph) return [];

    // G3: Level-dependent confidence floor — exclude decayed/irrelevant facts
    const confidenceFloor = (routingLevel ?? 1) === 0 ? 0.9 : 0.6;

    const facts: PerceptualHierarchy['verifiedFacts'] = [];
    for (const file of files) {
      if (!file) continue;
      try {
        const fileFacts = this.worldGraph.queryFacts(file);
        for (const f of fileFacts) {
          // G3: Skip facts below confidence floor
          if (f.confidence < confidenceFloor) continue;
          // G1: Pass through full oracle metadata (confidence, oracleName, tierReliability)
          facts.push({
            target: f.target,
            pattern: f.pattern,
            verified_at: f.verifiedAt,
            hash: f.fileHash,
            confidence: f.confidence,
            oracleName: f.oracleName,
            tierReliability: f.tierReliability,
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
