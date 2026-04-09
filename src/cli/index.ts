/**
 * Vinyan CLI entry point.
 */

import { join } from 'path';
import { analyzeSessionDir, formatMetrics, type GateRequest, runGate } from '../gate/index.ts';
import { init } from './init.ts';
import { runPatternsCommand } from './patterns.ts';
import { runAgentTask } from './run.ts';
import { runMetricsCommand, runRulesCommand, runSkillsCommand, runStatusCommand } from './status.ts';

const command = process.argv[2];
const workspacePath = process.argv[3] || process.cwd();
const force = process.argv.includes('--force');

switch (command) {
  case 'init': {
    const result = init(workspacePath, force);
    if (result.created) {
      console.log(`Created ${result.configPath}`);
    } else {
      console.error(result.reason);
      process.exit(1);
    }
    break;
  }

  case 'gate': {
    // Read JSON from stdin, run oracle gate, write verdict to stdout
    const wsOverride = process.argv.includes('--workspace')
      ? process.argv[process.argv.indexOf('--workspace') + 1]
      : undefined;

    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk as Buffer);
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim();

    if (!input) {
      console.error('Error: no JSON input on stdin');
      process.exit(2);
    }

    let request: GateRequest;
    try {
      request = JSON.parse(input) as GateRequest;
    } catch {
      console.error('Error: invalid JSON on stdin');
      process.exit(2);
    }

    // Validate GateRequest format
    if (!request.params) {
      console.error('Error: GateRequest requires "params" object with "file_path" and "workspace"');
      console.error(
        'Example: {"tool":"write_file","params":{"file_path":"src/foo.ts","content":"...","workspace":"."}}',
      );
      process.exit(2);
    }
    // Allow --workspace flag to override; default to cwd if missing
    if (wsOverride) {
      request.params.workspace = wsOverride;
    }
    if (!request.params.workspace) {
      request.params.workspace = process.cwd();
    }

    try {
      const verdict = await runGate(request);
      console.log(JSON.stringify(verdict));
      process.exit(verdict.decision === 'allow' ? 0 : 1);
    } catch (err) {
      console.error(`Gate error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
    break;
  }

  case 'analyze': {
    // Analyze session logs and print metrics
    const analyzeDir = process.argv[3] || join(workspacePath, '.vinyan', 'sessions');
    const metrics = analyzeSessionDir(analyzeDir);
    console.log(formatMetrics(metrics));
    break;
  }

  case 'run': {
    await runAgentTask(process.argv.slice(2));
    break;
  }

  case 'patterns': {
    await runPatternsCommand(process.argv.slice(3));
    break;
  }

  case 'status': {
    await runStatusCommand(workspacePath);
    break;
  }

  case 'metrics': {
    await runMetricsCommand(workspacePath);
    break;
  }

  case 'rules': {
    await runRulesCommand(workspacePath);
    break;
  }

  case 'skills': {
    await runSkillsCommand(workspacePath);
    break;
  }

  case 'serve': {
    const { serve } = await import('./serve.ts');
    await serve(workspacePath);
    break;
  }

  case 'mcp': {
    const { startMCPServer } = await import('./mcp.ts');
    await startMCPServer(workspacePath);
    break;
  }

  case 'tui': {
    const { processTUICommand } = await import('../tui/commands.ts');
    await processTUICommand(process.argv.slice(3), { workspace: workspacePath });
    break;
  }

  case 'oracle': {
    const subcommand = process.argv[3];
    if (subcommand === 'test') {
      const { runOracleTest } = await import('./oracle-test.ts');
      await runOracleTest(process.argv.slice(4));
    } else {
      console.error('Usage: vinyan oracle test <oracle-name> [--workspace <path>] [--pattern <pattern>]');
      process.exit(1);
    }
    break;
  }

  default:
    console.error(
      `Usage: vinyan <command>\n\nCommands:\n  init [path]        Initialize vinyan.json\n  gate               Run oracle gate (JSON on stdin)\n  analyze [dir]      Analyze session logs\n  run "task"         Run autonomous agent task\n  patterns           Export/import patterns for cross-project transfer\n  status             Show system status summary\n  metrics            Print full system metrics as JSON\n  rules              List evolutionary rules\n  skills             List cached skills\n  serve              Start the API server (Phase 5)\n  mcp                Start MCP server over stdio (Phase 5)\n  oracle test <name> Test an oracle implementation\n  tui [subcommand]   Interactive Terminal UI (default: full dashboard)`,
    );
    process.exit(1);
}
