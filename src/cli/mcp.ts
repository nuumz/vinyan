/**
 * CLI: vinyan mcp — start MCP server over stdio.
 *
 * Connects Vinyan oracles to MCP clients (Claude Code, etc.)
 * via JSON-RPC over stdin/stdout.
 */
import { VinyanMCPServer } from "../mcp/server.ts";
import { runOracle } from "../oracle/runner.ts";
import { WorldGraph } from "../world-graph/world-graph.ts";
import { join } from "path";

export async function startMCPServer(workspace: string): Promise<void> {
  // Try to connect WorldGraph for fact queries
  let worldGraph: WorldGraph | undefined;
  try {
    worldGraph = new WorldGraph(join(workspace, ".vinyan", "world-graph.db"));
  } catch {
    // WorldGraph unavailable — fact queries will return empty
  }

  const server = new VinyanMCPServer({
    runOracle: (name, hypothesis) => runOracle(name, hypothesis),
    queryFacts: worldGraph
      ? (target) => worldGraph!.queryFacts(target)
      : () => [],
  });

  await server.startStdio();

  worldGraph?.close();
}
