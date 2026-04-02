/**
 * TUI Commands — interactive command processing for the terminal UI.
 *
 * Provides real-time event monitoring, audit replay, system inspection,
 * and the full interactive terminal UI.
 */

import { readFileSync } from 'fs';
import type { VinyanBus } from '../core/bus.ts';
import { createOrchestrator } from '../orchestrator/factory.ts';
import { App } from './app.ts';
import { EmbeddedDataSource } from './data/source.ts';
import { EventRenderer } from './event-renderer.ts';
import { ANSI, bold, box, color, dim } from './renderer.ts';
import { parseAuditLog, replayAuditLog, summarizeAuditLog } from './replay.ts';
import { restoreSession } from './session.ts';
import { createInitialState } from './state.ts';

export interface TUIConfig {
  bus?: VinyanBus;
  workspace: string;
}

/**
 * Start the TUI in watch mode — subscribe to bus events and render them live.
 */
export function startWatch(config: TUIConfig): { stop: () => void } {
  const renderer = new EventRenderer({ showTimestamps: true });

  console.log(box('Vinyan TUI', 'Watching for events... (Ctrl+C to exit)'));
  console.log('');

  if (config.bus) {
    renderer.attach(config.bus);
  } else {
    console.log(dim('No bus available — start the orchestrator to see events.'));
  }

  return {
    stop() {
      renderer.detach();
      console.log('');
      console.log(dim('TUI stopped.'));
    },
  };
}

/**
 * Replay an audit log file.
 */
export async function replayFile(filePath: string, options?: { realtime?: boolean; speed?: number }): Promise<void> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(color(`Failed to read audit file: ${filePath}`, ANSI.red));
    console.error(dim(err instanceof Error ? err.message : String(err)));
    return;
  }

  const entries = parseAuditLog(content);
  if (entries.length === 0) {
    console.log(dim('No audit entries found in file.'));
    return;
  }

  // Show summary first
  console.log(summarizeAuditLog(entries));
  console.log('');

  // Replay
  await replayAuditLog(entries, {
    realtime: options?.realtime ?? false,
    speedMultiplier: options?.speed ?? 10,
  });
}

/**
 * Show a system overview (status summary).
 */
export function showOverview(config: TUIConfig): void {
  const lines: string[] = [];
  lines.push(`${bold('Workspace:')} ${config.workspace}`);
  lines.push(`${bold('Bus:')} ${config.bus ? color('connected', ANSI.green) : color('disconnected', ANSI.red)}`);

  console.log(box('Vinyan System Overview', lines.join('\n')));
}

/**
 * Start the full interactive TUI with dashboard, tasks, and peers views.
 * Screen and keyboard are responsive immediately — orchestrator initializes in background.
 */
export async function startInteractive(config: TUIConfig): Promise<void> {
  const state = createInitialState(config.workspace);
  restoreSession(state, config.workspace);

  // Start TUI immediately in loading mode
  const app = new App({ state });

  // Yield event loop — lets render loop paint between heavy sync steps
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  // Initialize orchestrator in async steps, yielding between each
  let orchestrator: ReturnType<typeof createOrchestrator> | null = null;
  const initOrchestrator = async () => {
    try {
      state.loadingMessage = 'Initializing orchestrator...';
      state.dirty = true;
      await tick();

      orchestrator = createOrchestrator({ workspace: config.workspace, bus: config.bus });

      state.loadingMessage = 'Starting data source...';
      state.dirty = true;
      await tick();

      const dataSource = new EmbeddedDataSource(state, orchestrator);
      app.wireDataSource(dataSource);
    } catch (err) {
      state.loadingMessage = `Init failed: ${err instanceof Error ? err.message : String(err)}`;
      state.dirty = true;
    }
  };

  // Start init after first frame renders
  setTimeout(() => { initOrchestrator(); }, 0);

  app.onShutdown(() => orchestrator?.close());
  await app.run();
}

/**
 * Process a TUI subcommand.
 */
export async function processTUICommand(args: string[], config: TUIConfig): Promise<void> {
  const subcommand = args[0] ?? 'interactive';

  switch (subcommand) {
    case 'interactive':
    case 'i':
      await startInteractive(config);
      break;

    case 'watch':
      startWatch(config);
      // Keep process alive
      await new Promise(() => {}); // Block indefinitely; Ctrl+C exits
      break;

    case 'replay': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: vinyan tui replay <audit-file.jsonl> [--realtime] [--speed N]');
        process.exit(1);
      }
      const realtime = args.includes('--realtime');
      const speedIdx = args.indexOf('--speed');
      const speed = speedIdx >= 0 ? parseFloat(args[speedIdx + 1]!) : undefined;
      await replayFile(filePath, { realtime, speed });
      break;
    }

    case 'overview':
      showOverview(config);
      break;

    default:
      console.log(bold('Vinyan TUI'));
      console.log('');
      console.log('Subcommands:');
      console.log('  interactive (i)    Full interactive terminal UI (default)');
      console.log('  watch              Watch live bus events (simple mode)');
      console.log('  replay <file>      Replay audit log file');
      console.log('  overview           Show system overview');
      console.log('');
      console.log('Options:');
      console.log('  --realtime         Replay with timing (for replay)');
      console.log('  --speed N          Playback speed multiplier (default: 10)');
  }
}
