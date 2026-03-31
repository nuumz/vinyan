/**
 * Vinyan CLI entry point.
 */
import { init } from "./init.ts";
import { join } from "path";
import { runGate, type GateRequest, analyzeSessionDir, formatMetrics } from "../gate/index.ts";
import { runAgentTask } from "./run.ts";
import { runPatternsCommand } from "./patterns.ts";

const command = process.argv[2];
const workspacePath = process.argv[3] || process.cwd();
const force = process.argv.includes("--force");

switch (command) {
  case "init": {
    const result = init(workspacePath, force);
    if (result.created) {
      console.log(`Created ${result.configPath}`);
    } else {
      console.error(result.reason);
      process.exit(1);
    }
    break;
  }

  case "gate": {
    // Read JSON from stdin, run oracle gate, write verdict to stdout
    const wsOverride = process.argv.includes("--workspace")
      ? process.argv[process.argv.indexOf("--workspace") + 1]
      : undefined;

    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk as Buffer);
    }
    const input = Buffer.concat(chunks).toString("utf-8").trim();

    if (!input) {
      console.error("Error: no JSON input on stdin");
      process.exit(2);
    }

    let request: GateRequest;
    try {
      request = JSON.parse(input) as GateRequest;
    } catch {
      console.error("Error: invalid JSON on stdin");
      process.exit(2);
    }

    // Allow --workspace flag to override
    if (wsOverride) {
      request.params.workspace = wsOverride;
    }

    try {
      const verdict = await runGate(request);
      console.log(JSON.stringify(verdict));
      process.exit(verdict.decision === "allow" ? 0 : 1);
    } catch (err) {
      console.error(`Gate error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    break;
  }

  case "analyze": {
    // Analyze session logs and print metrics
    const analyzeDir = process.argv[3] || join(workspacePath, ".vinyan", "sessions");
    const metrics = analyzeSessionDir(analyzeDir);
    console.log(formatMetrics(metrics));
    break;
  }

  case "run": {
    await runAgentTask(process.argv.slice(2));
    break;
  }

  case "patterns": {
    await runPatternsCommand(process.argv.slice(3));
    break;
  }

  default:
    console.error(
      `Usage: vinyan <command>\n\nCommands:\n  init [path]     Initialize vinyan.json\n  gate             Run oracle gate (JSON on stdin)\n  analyze [dir]    Analyze session logs\n  run "task"       Run autonomous agent task\n  patterns         Export/import patterns for cross-project transfer`,
    );
    process.exit(1);
}
