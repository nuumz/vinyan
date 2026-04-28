/**
 * Vinyan CLI entry point.
 */

import { join } from 'path';
import { resolveProfile } from '../config/profile-resolver.ts';
import { analyzeSessionDir, formatMetrics, type GateRequest, runGate } from '../gate/index.ts';
import { init } from './init.ts';
import { runPatternsCommand } from './patterns.ts';
import { runAgentTask } from './run.ts';
import { runMetricsCommand, runRulesCommand, runSkillsCommand, runStatusCommand } from './status.ts';

const VERSION = '0.1.0';

/**
 * Extract a `--profile <name>` / `-p <name>` flag from an argv array.
 *
 * Exported for unit tests. Returns `undefined` when the flag is absent.
 * Throws when the flag appears without a value so the user sees the
 * error instead of an argv drift (`-p --verbose` would otherwise
 * silently consume `--verbose` as the profile name).
 */
export function extractProfileFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile' || a === '-p') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`Flag ${a} requires a profile name`);
      }
      return next;
    }
    // Support `--profile=work` form as well.
    if (a !== undefined && a.startsWith('--profile=')) {
      const val = a.slice('--profile='.length);
      if (val.length === 0) throw new Error('Flag --profile requires a profile name');
      return val;
    }
  }
  return undefined;
}

function printUsage(stream: NodeJS.WritableStream = process.stdout) {
  stream.write(`Vinyan ${VERSION} — Epistemic Orchestration CLI

Usage: vinyan <command> [options]

Commands:
  run "task"         Run autonomous agent task (supports --agent <id>)
  agent <sub>        Manage specialist agents (list|create|inspect|remove)
  chat               Interactive conversation agent mode
  serve              Start the API server (auto-restart on crash; --watch for hot reload; --no-supervise to disable)
  init [path]        Initialize vinyan.json
  status             Show system status summary
  doctor             Health check: config, DB, oracles, LLM providers

  config show|validate  View or validate configuration
  session list|delete|export  Manage conversation sessions
  logs [--limit N]   Inspect execution traces

  economy [sub]      Economy OS: budget, costs, market, trust
  trajectory <sub>   Export execution traces (ShareGPT or ECP-enriched)
  routing-explain <task_id>  Explain why a task was routed to Lx (observable routing)
  metrics            Print full system metrics as JSON
  rules              List evolutionary rules
  skills             List cached skills (subcommands: import, bind, unbind)
  patterns           Export/import patterns for cross-project transfer
  memory [sub]       Review agent-proposed memory
  schedule <sub>     Manage NL-cron schedules (create|list|show|delete)
  skills import <id> Import a SKILL.md from an external registry (github:… / agentskills:…)
  skills bind <persona> <skill> [--pin <ver>]   Bind a skill to a persona (workspace-scoped)
  skills unbind <persona> <skill>               Remove a persona-scoped skill binding

  gate               Run oracle gate (JSON on stdin)
  analyze [dir]      Analyze session logs
  oracle test <name> Test an oracle implementation
  mcp                Start MCP server over stdio
  tui [subcommand]   Interactive Terminal UI
  clean              Database maintenance (VACUUM, purge)

Flags:
  --version, -v                  Show version
  --help, -h                     Show this help
  --profile <name>, -p <name>    Use profile namespace <name> (default: 'default';
                                 env: VINYAN_PROFILE; must match /^[a-z][a-z0-9-]*$/)
`);
}

// ── Module guard ──────────────────────────────────────────────────────
// This file doubles as the CLI entry point AND as a re-export surface
// for helpers like `extractProfileFlag`. Without this guard, simply
// importing the module from a unit test would execute the dispatch
// block below (printing usage, calling process.exit, etc.). The guard
// keeps the dispatch CLI-only; test imports get the exported helpers
// and nothing else.
if (!import.meta.main) {
  // Importing as a library — stop before running any CLI dispatch.
  // Using a throw-less early return via a labeled block isn't possible
  // at the top level, so we wrap the remainder in an if(main) block.
}

if (import.meta.main) {
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
  // args[1] is an optional workspace path — but only if it doesn't start with '-'
  // (otherwise it's a flag like --watch or --no-supervise).
  const workspacePath = args[1] && !args[1].startsWith('-') ? args[1] : process.cwd();
  const force = args.includes('--force');

  // ── Profile flag extraction (W1 PR #1 consumer wiring) ────────────────
  // Parse -p / --profile here so every subcommand dispatches with the same
  // resolved profile. `resolveProfile` applies flag > env(VINYAN_PROFILE) >
  // 'default' precedence internally; we just collect the flag value.
  //
  // Export the resolved name back into the environment so child modules
  // (chat.ts, run.ts, serve.ts, api server, etc.) that may not receive an
  // explicit parameter can still pick it up via VINYAN_PROFILE without
  // plumbing every call site in this PR.
  let profileFlagValue: string | undefined;
  try {
    profileFlagValue = extractProfileFlag(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const resolvedProfile = resolveProfile({ flag: profileFlagValue });
  process.env['VINYAN_PROFILE'] = resolvedProfile.name;

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
      await runAgentTask(args, { profile: resolvedProfile.name });
      break;
    }

    case 'agent': {
      const { runAgentCommand } = await import('./agent.ts');
      await runAgentCommand(args.slice(1), workspacePath);
      break;
    }

    case 'chat': {
      const { startChat } = await import('./chat.ts');
      await startChat(args.slice(1), { profile: resolvedProfile.name });
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
      // Sub-subcommand dispatch:
      //   `skills import <id>`              → hub importer (W3 SK3)
      //   `skills bind <persona> <skill>`   → persona-scoped binding (Phase 2)
      //   `skills unbind <persona> <skill>` → remove persona-scoped binding
      //   anything else                     → legacy `runSkillsCommand` (list)
      if (args[1] === 'import') {
        const { runSkillsImportCommand } = await import('./skills-import.ts');
        await runSkillsImportCommand(args.slice(2), { profile: resolvedProfile.name });
      } else if (args[1] === 'bind') {
        try {
          const { runSkillBindCommand } = await import('./skill-bind.ts');
          await runSkillBindCommand(args.slice(2), workspacePath);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      } else if (args[1] === 'unbind') {
        try {
          const { runSkillUnbindCommand } = await import('./skill-bind.ts');
          await runSkillUnbindCommand(args.slice(2), workspacePath);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(2);
        }
      } else {
        await runSkillsCommand(workspacePath);
      }
      break;
    }

    case 'schedule': {
      const { runScheduleCommand } = await import('./schedule.ts');
      await runScheduleCommand(args.slice(1), { profile: resolvedProfile.name });
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
        await serve(workspacePath, { profile: resolvedProfile.name });
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

    case 'trajectory': {
      const { runTrajectoryCommand } = await import('./trajectory.ts');
      await runTrajectoryCommand(args.slice(1), workspacePath);
      break;
    }

    case 'routing-explain': {
      const { runRoutingExplainCommand } = await import('./routing-explain.ts');
      await runRoutingExplainCommand(args.slice(1), {
        workspace: workspacePath,
        profile: resolvedProfile.name,
      });
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
} // end if (import.meta.main)
