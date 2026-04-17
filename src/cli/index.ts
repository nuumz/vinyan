/**
 * Vinyan CLI entry point.
 */

import { join } from 'path';
import { analyzeSessionDir, formatMetrics, type GateRequest, runGate } from '../gate/index.ts';
import { init } from './init.ts';
import { runPatternsCommand } from './patterns.ts';
import { runAgentTask } from './run.ts';
import { runMetricsCommand, runRulesCommand, runSkillsCommand, runStatusCommand } from './status.ts';

const VERSION = '0.1.0';

function printUsage(stream: NodeJS.WritableStream = process.stdout) {
  stream.write(`Vinyan ${VERSION} — Epistemic Orchestration CLI

Usage: vinyan <command> [options]

Commands:
  run "task"         Run autonomous agent task (supports --agent <id>)
  agent <sub>        Manage specialist agents (list|add|remove|show)
  chat               Interactive conversation agent mode
  serve              Start the API server (auto-restart on crash; --no-supervise to disable)
  init [path]        Initialize vinyan.json
  status             Show system status summary
  doctor             Health check: config, DB, oracles, LLM providers

  config show|validate  View or validate configuration
  session list|delete|export  Manage conversation sessions
  logs [--limit N]   Inspect execution traces

  economy [sub]      Economy OS: budget, costs, market, trust
  metrics            Print full system metrics as JSON
  rules              List evolutionary rules
  skills             List cached skills
  patterns           Export/import patterns for cross-project transfer
  memory [sub]       Review agent-proposed memory

  gate               Run oracle gate (JSON on stdin)
  analyze [dir]      Analyze session logs
  oracle test <name> Test an oracle implementation
  mcp                Start MCP server over stdio
  tui [subcommand]   Interactive Terminal UI
  clean              Database maintenance (VACUUM, purge)

Flags:
  --version, -v      Show version
  --help, -h         Show this help
`);
}

// Handle --version and --help before command routing
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  printUsage();
  process.exit(0);
}

const command = args[0];
const workspacePath = args[1] || process.cwd();
const force = args.includes('--force');

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
    const wsOverride = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : undefined;

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

    if (!request.params) {
      console.error('Error: GateRequest requires "params" object with "file_path" and "workspace"');
      process.exit(2);
    }
    if (wsOverride) request.params.workspace = wsOverride;
    if (!request.params.workspace) request.params.workspace = process.cwd();

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
    const analyzeDir = args[1] || join(workspacePath, '.vinyan', 'sessions');
    const metrics = analyzeSessionDir(analyzeDir);
    console.log(formatMetrics(metrics));
    break;
  }

  case 'run': {
    await runAgentTask(args);
    break;
  }

  case 'agent': {
    const { runAgentCommand } = await import('./agent.ts');
    await runAgentCommand(args.slice(1), workspacePath);
    break;
  }

  case 'chat': {
    const { startChat } = await import('./chat.ts');
    await startChat(args.slice(1));
    break;
  }

  case 'patterns': {
    await runPatternsCommand(args.slice(1));
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
    // Supervisor mode: default ON. Parent process respawns the child on
    // crash so one bad task can never take down the API server permanently.
    // Disable with --no-supervise (useful for dev/debugging).
    const supervise = !args.includes('--no-supervise') && process.env.VINYAN_SUPERVISED !== '1';
    if (supervise) {
      const { superviseServe } = await import('./supervise.ts');
      await superviseServe(workspacePath, process.argv);
    } else {
      const { serve } = await import('./serve.ts');
      await serve(workspacePath);
    }
    break;
  }

  case 'mcp': {
    const { startMCPServer } = await import('./mcp.ts');
    await startMCPServer(workspacePath);
    break;
  }

  case 'economy': {
    const { runEconomyCommand } = await import('./economy.ts');
    await runEconomyCommand(args.slice(1));
    break;
  }

  case 'tui': {
    const { processTUICommand } = await import('../tui/commands.ts');
    await processTUICommand(args.slice(1), { workspace: workspacePath });
    break;
  }

  case 'oracle': {
    if (args[1] === 'test') {
      const { runOracleTest } = await import('./oracle-test.ts');
      await runOracleTest(args.slice(2));
    } else {
      console.error('Usage: vinyan oracle test <oracle-name> [--workspace <path>]');
      process.exit(1);
    }
    break;
  }

  case 'memory': {
    const { runMemoryCommand } = await import('./memory.ts');
    await runMemoryCommand(args.slice(1));
    break;
  }

  case 'doctor': {
    const { runDoctor } = await import('./doctor.ts');
    await runDoctor(workspacePath);
    break;
  }

  case 'config': {
    const { runConfigCommand } = await import('./config-cmd.ts');
    await runConfigCommand(args.slice(1));
    break;
  }

  case 'session': {
    const { runSessionCommand } = await import('./session-cmd.ts');
    await runSessionCommand(args.slice(1));
    break;
  }

  case 'logs': {
    const { runLogsCommand } = await import('./logs.ts');
    await runLogsCommand(args.slice(1));
    break;
  }

  case 'clean': {
    const { runCleanCommand } = await import('./clean.ts');
    await runCleanCommand(args.slice(1));
    break;
  }

  default:
    console.error(`Unknown command: ${command}\n`);
    printUsage(process.stderr);
    process.exit(1);
}
