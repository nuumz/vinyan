/**
 * Tier 3 Causal BFS Predictor — computes break risk via BFS over causal edges.
 *
 * Pure algorithmic module: takes edges + file stats, returns risk analysis.
 * No I/O, no side effects.
 *
 * Axiom: A7 (prediction error as learning signal)
 */
import type {
  CausalEdge,
  CausalEdgeType,
  CausalRiskAnalysis,
  CausalRiskEntry,
  FileOutcomeStat,
  LearnedEdgeWeights,
} from './forward-predictor-types.ts';
import { CAUSAL_EDGE_WEIGHTS } from './forward-predictor-types.ts';

const MAX_BFS_DEPTH = 3;
const MAX_RISK_FILES = 10;
const DEFAULT_FAIL_RATE = 0.1;

export interface CausalPredictor {
  computeRisks(
    targetFiles: string[],
    edges: CausalEdge[],
    fileStats: FileOutcomeStat[],
    tier2PPass: number,
    learnedWeights?: LearnedEdgeWeights,
  ): CausalRiskAnalysis;
}

interface BfsEntry {
  filePath: string;
  depth: number;
  pathWeight: number;
  chain: Array<{
    fromFile: string;
    toFile: string;
    edgeType: CausalEdgeType | 'imports';
    fromSymbol?: string;
    toSymbol?: string;
  }>;
}

export class CausalPredictorImpl implements CausalPredictor {
  computeRisks(
    targetFiles: string[],
    edges: CausalEdge[],
    fileStats: FileOutcomeStat[],
    tier2PPass: number,
    learnedWeights?: LearnedEdgeWeights,
  ): CausalRiskAnalysis {
    if (edges.length === 0) {
      return { adjustedPPass: tier2PPass, riskFiles: [], aggregateRisk: 0 };
    }

    const weights = this.resolveWeights(learnedWeights);
    const adjacency = this.buildAdjacency(edges);
    const failRates = this.buildFailRateMap(fileStats);

    // BFS from target files
    const riskMap = new Map<string, { breakProbability: number; chain: BfsEntry['chain'] }>();
    const visited = new Set<string>(targetFiles);
    const queue: BfsEntry[] = [];

    // Seed: direct dependents of target files
    for (const target of targetFiles) {
      const neighbors = adjacency.get(target);
      if (!neighbors) continue;
      for (const edge of neighbors) {
        if (visited.has(edge.toFile)) continue;
        const edgeWeight = weights[edge.edgeType] ?? weights.imports;
        queue.push({
          filePath: edge.toFile,
          depth: 1,
          pathWeight: edgeWeight,
          chain: [{
            fromFile: edge.fromFile,
            toFile: edge.toFile,
            edgeType: edge.edgeType,
            fromSymbol: edge.fromSymbol,
            toSymbol: edge.toSymbol,
          }],
        });
      }
    }

    // BFS loop (FIFO)
    for (let head = 0; head < queue.length; head++) {
      const entry = queue[head]!;

      // Keep the highest pathWeight per file
      const existing = riskMap.get(entry.filePath);
      if (!existing || entry.pathWeight > existing.breakProbability / (failRates.get(entry.filePath) ?? DEFAULT_FAIL_RATE)) {
        const failRate = failRates.get(entry.filePath) ?? DEFAULT_FAIL_RATE;
        riskMap.set(entry.filePath, {
          breakProbability: entry.pathWeight * failRate,
          chain: entry.chain,
        });
      }

      if (entry.depth >= MAX_BFS_DEPTH) continue;

      visited.add(entry.filePath);
      const neighbors = adjacency.get(entry.filePath);
      if (!neighbors) continue;

      for (const edge of neighbors) {
        if (visited.has(edge.toFile)) continue;
        const edgeWeight = weights[edge.edgeType] ?? weights.imports;
        queue.push({
          filePath: edge.toFile,
          depth: entry.depth + 1,
          pathWeight: entry.pathWeight * edgeWeight,
          chain: [...entry.chain, {
            fromFile: edge.fromFile,
            toFile: edge.toFile,
            edgeType: edge.edgeType,
            fromSymbol: edge.fromSymbol,
            toSymbol: edge.toSymbol,
          }],
        });
      }
    }

    // Build risk entries with historical success rate
    const successRateMap = this.buildSuccessRateMap(fileStats);
    const riskEntries: CausalRiskEntry[] = [];
    for (const [filePath, { breakProbability, chain }] of riskMap) {
      const entry: CausalRiskEntry = { filePath, breakProbability, causalChain: chain };
      const rate = successRateMap.get(filePath);
      if (rate !== undefined) entry.historicalSuccessRate = rate;
      riskEntries.push(entry);
    }

    // Sort descending by breakProbability, take top 10
    riskEntries.sort((a, b) => b.breakProbability - a.breakProbability);
    const topRisks = riskEntries.slice(0, MAX_RISK_FILES);

    // Aggregate risk: P(≥1 break) = 1 - ∏(1 - P(file_i breaks))
    const aggregateRisk = 1 - topRisks.reduce(
      (product, r) => product * (1 - r.breakProbability),
      1,
    );

    const adjustedPPass = tier2PPass * (1 - aggregateRisk);

    return { adjustedPPass, riskFiles: topRisks, aggregateRisk };
  }

  private resolveWeights(learned?: LearnedEdgeWeights): Record<CausalEdgeType | 'imports', number> {
    if (learned?.converged) return { ...learned.weights };
    return { ...CAUSAL_EDGE_WEIGHTS };
  }

  private buildAdjacency(edges: CausalEdge[]): Map<string, CausalEdge[]> {
    const adj = new Map<string, CausalEdge[]>();
    for (const edge of edges) {
      let list = adj.get(edge.fromFile);
      if (!list) {
        list = [];
        adj.set(edge.fromFile, list);
      }
      list.push(edge);
    }
    return adj;
  }

  private buildFailRateMap(fileStats: FileOutcomeStat[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const stat of fileStats) {
      if (stat.samples > 0) {
        map.set(stat.filePath, stat.failCount / stat.samples);
      }
    }
    return map;
  }

  private buildSuccessRateMap(fileStats: FileOutcomeStat[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const stat of fileStats) {
      if (stat.samples > 0) {
        map.set(stat.filePath, stat.successCount / stat.samples);
      }
    }
    return map;
  }
}
