/**
 * CLI: vinyan chat — interactive conversation agent mode.
 *
 * Creates a persistent conversation session where each user message flows
 * through the full Orchestrator pipeline (understanding → routing → generate → verify).
 * Conversation history persists to SQLite across restarts.
 *
 * Usage:
 *   vinyan chat                          Start a new conversation
 *   vinyan chat --resume <sessionId>     Resume a previous conversation
 *   vinyan chat --list                   List available sessions
 *   vinyan chat --thinking               Show LLM thinking process
 *   vinyan chat --workspace <path>       Override workspace
 */

import { join } from 'path';
import { createInterface } from 'readline';
import { SessionManager } from '../api/session-manager.ts';
import { SessionStore } from '../db/session-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { expandSlashCommand } from '../orchestrator/commands/command-expander.ts';
import { loadSlashCommands, type SlashCommandRegistry } from '../orchestrator/commands/command-loader.ts';
import { createOrchestrator } from '../orchestrator/factory.ts';
import type { TaskInput } from '../orchestrator/types.ts';
import { attachChatStreamRenderer } from './chat-stream-renderer.ts';

// ── Constants ──────────────────────────────────────────────

const DEFAULT_BUDGET = {
  maxTokens: 50_000,
  maxDurationMs: 120_000,
  maxRetries: 3,
};

const PROMPT = '\x1b[36mvinyan>\x1b[0m '; // Cyan prompt

// ── Main ───────────────────────────────────────────────────

export async function startChat(argv: string[]): Promise<void> {
  const workspace = parseSingleFlag(argv, '--workspace') ?? process.cwd();
  const resumeId = parseSingleFlag(argv, '--resume');
  const listMode = argv.includes('--list');
  let showThinking = argv.includes('--thinking');

  // DB + SessionManager
  const db = new VinyanDB(join(workspace, '.vinyan', 'vinyan.db'));
  const sessionStore = new SessionStore(db.getDb());
  const sessionManager = new SessionManager(sessionStore);

  // --list: show sessions and exit
  if (listMode) {
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) {
      console.log('No sessions found.');
    } else {
      console.log('Sessions:');
      for (const s of sessions) {
        const msgs = sessionManager.getMessageCount(s.id);
        const date = new Date(s.createdAt).toLocaleString();
        console.log(`  ${s.id.slice(0, 8)}  ${s.status.padEnd(10)} ${msgs} messages  ${date}`);
      }
    }
    db.close();
    return;
  }

  // Create orchestrator with session manager for cross-turn context
  const orchestrator = createOrchestrator({ workspace, llmProxy: true, sessionManager });

  // Track the currently-active per-turn stream renderer so /thinking can
  // toggle it live without waiting for the next task to start.
  let activeRenderer: ReturnType<typeof attachChatStreamRenderer> | null = null;

  // Create or resume session
  let session: ReturnType<typeof sessionManager.create>;
  if (resumeId) {
    const existing = sessionManager.get(resumeId);
    if (!existing) {
      // Try prefix match
      const all = sessionManager.listSessions();
      const match = all.find((s) => s.id.startsWith(resumeId));
      if (!match) {
        console.error(`Session not found: ${resumeId}`);
        orchestrator.close();
        db.close();
        process.exit(1);
      }
      session = match;
    } else {
      session = existing;
    }
    const history = sessionManager.getConversationHistory(session.id);
    if (history.length > 0) {
      console.log(`\x1b[2mResuming session ${session.id.slice(0, 8)} (${history.length} messages)\x1b[0m`);
      // Show last 3 turns as context recap
      const recap = history.slice(-6);
      for (const entry of recap) {
        const prefix = entry.role === 'user' ? '\x1b[33mYou:\x1b[0m' : '\x1b[32mVinyan:\x1b[0m';
        const text = entry.content.length > 200 ? `${entry.content.slice(0, 200)}...` : entry.content;
        console.log(`  ${prefix} ${text}`);
      }
      console.log();
    }
  } else {
    session = sessionManager.create('cli');
    console.log(`\x1b[2mNew session: ${session.id.slice(0, 8)}\x1b[0m`);
  }

  // Phase 7d-2: load user-defined slash commands from `.vinyan/commands/`.
  // The registry is built once per chat session — restart the chat to pick
  // up newly-added commands. Loader errors surface via `/commands`.
  const slashRegistry = loadSlashCommands(workspace);
  if (slashRegistry.errors.length > 0) {
    console.log(
      `\x1b[33m  (${slashRegistry.errors.length} slash command file(s) failed to load — run /commands to see details)\x1b[0m`,
    );
  }

  const userCmdNames =
    slashRegistry.commands.size > 0
      ? ` · user: ${[...slashRegistry.commands.keys()].map((n) => `/${n}`).join(' ')}`
      : '';
  console.log(
    `Type a message to chat. Commands: /exit, /session, /history, /thinking, /clear, /commands${userCmdNames}\n`,
  );

  // readline loop
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
  });

  let isProcessing = false; // Guard against concurrent executeTask calls
  let turnCount = 0;
  // Agent Conversation: when the previous turn ended in `input-required`,
  // the agent is waiting for the user to answer follow-up questions. We
  // capture those questions here so the NEXT user message can be tagged as
  // a clarification answer rather than a fresh intent.
  let pendingClarifications: string[] = sessionManager.getPendingClarifications(session.id);
  if (pendingClarifications.length > 0) {
    console.log('\x1b[33m(Vinyan is waiting for you to answer:)\x1b[0m');
    for (const q of pendingClarifications) console.log(`  • ${q}`);
    console.log();
  }

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();

    // Empty line
    if (!input) {
      rl.prompt();
      return;
    }

    // Phase 7d-2: Slash-command handling.
    //
    //   1. CLI built-ins (/exit, /session, ...) are checked first and
    //      short-circuit without hitting the orchestrator.
    //   2. If the input is a slash command but NOT a built-in, we look
    //      it up in the user-defined registry (`.vinyan/commands/`).
    //      A match expands to the command's body (with $ARGUMENTS
    //      substituted) and dispatches it as the task goal, while the
    //      user turn recorded in history is still the raw typed input.
    //   3. An unknown slash command prints a helpful error listing both
    //      built-ins and user commands, then prompts again.
    let taskGoal = input;
    if (input.startsWith('/')) {
      const builtinHandled = tryBuiltinCommand(input, session, sessionManager, slashRegistry, showThinking, (v) => {
        showThinking = v;
        // Propagate to the live renderer so an in-flight turn picks up the
        // new thinking preference immediately (the buffered thinking block
        // only opens on the NEXT thinking delta, so nothing to rewind).
        activeRenderer?.setShowThinking(v);
      });
      if (builtinHandled) {
        rl.prompt();
        return;
      }

      const expansion = expandSlashCommand(input, slashRegistry);
      if (expansion.kind === 'expanded') {
        taskGoal = expansion.prompt;
        console.log(`\x1b[2m  (expanding /${expansion.name})\x1b[0m`);
      } else if (expansion.kind === 'unknown_command') {
        const userList = [...slashRegistry.commands.keys()].map((n) => `/${n}`).join(' ');
        console.log(
          `  Unknown command: /${expansion.name}. Built-ins: /exit /session /history /thinking /clear /commands${
            userList ? ` · user: ${userList}` : ''
          }`,
        );
        rl.prompt();
        return;
      } else {
        // `not_a_command` shouldn't occur here because we checked startsWith('/'),
        // but fall through defensively so a bare `/` doesn't crash the loop.
        rl.prompt();
        return;
      }
    }

    // Prevent concurrent task execution (readline fires events even while async handler is running)
    if (isProcessing) {
      console.log('\x1b[2m  (still processing previous message, please wait...)\x1b[0m');
      return;
    }
    isProcessing = true;

    // Record user turn — store the ORIGINAL typed input so history
    // faithfully shows `/commit foo` rather than the expanded prompt.
    sessionManager.recordUserTurn(session.id, input);

    // Agent Conversation: if the previous turn was input-required, inject the
    // open questions + this user message as typed constraints so the
    // understanding pipeline sees this turn as a clarification answer, not a
    // fresh intent. Each question becomes a CLARIFIED:<q>=><a> constraint.
    const clarificationConstraints: string[] =
      pendingClarifications.length > 0
        ? pendingClarifications.map((q) => `CLARIFIED:${q}=>${input}`)
        : [];
    const constraintsForTurn = [
      ...(showThinking ? ['THINKING:enabled'] : []),
      ...clarificationConstraints,
    ];
    // Consume — a single answer resolves all queued questions for this turn.
    pendingClarifications = [];

    // Build TaskInput — let understanding pipeline classify per-turn (D1)
    // taskType defaults to 'reasoning' but code-related goals with target files
    // can be classified as code-mutation/code-reasoning by the pipeline.
    const hasCodeContext = /`[^`]+`|\.(?:ts|js|py|java|tsx|jsx|go|rs)\b/.test(taskGoal);
    const taskInput: TaskInput = {
      id: `chat-${Date.now().toString(36)}`,
      source: 'cli',
      goal: taskGoal,
      taskType: hasCodeContext ? 'code' : 'reasoning',
      sessionId: session.id,
      budget: DEFAULT_BUDGET,
      ...(constraintsForTurn.length > 0 ? { constraints: constraintsForTurn } : {}),
    };

    try {
      // Attach a fresh per-turn timeline renderer, scoped to this taskId so
      // events from sibling tasks (delegations, peers) don't cross-render.
      activeRenderer = attachChatStreamRenderer(orchestrator.bus, {
        taskId: taskInput.id,
        color: process.stdout.isTTY ?? false,
        showThinking,
      });

      const result = await orchestrator.executeTask(taskInput);

      // Detach the renderer before we render the final answer — otherwise a
      // late `task:complete` event would print a second footer below it.
      activeRenderer.flushSummary();
      const answerWasStreamed = activeRenderer.didStreamAnswer();
      activeRenderer.detach();
      activeRenderer = null;

      // Record assistant turn
      sessionManager.recordAssistantTurn(session.id, taskInput.id, result);

      // Display non-streamed thinking (only when the provider didn't emit
      // thinking deltas — otherwise the renderer already showed them live).
      if (showThinking && result.thinking) {
        console.log(`\x1b[2m[thinking]\n${result.thinking}\n[/thinking]\x1b[0m`);
      }

      // Display response. If the answer was already streamed inline via
      // deltas (the renderer's `vinyan:` block), we skip reprinting it to
      // avoid a duplicate. Clarifications and mutations still render below.
      if (result.status === 'input-required') {
        // Agent Conversation: surface clarification questions as a friendly
        // prompt, NOT an error. Queue them so the next user line is tagged
        // as a clarification answer via constraints.
        if (result.answer && !answerWasStreamed) {
          console.log(`\n${result.answer}\n`);
        }
        const questions = result.clarificationNeeded ?? [];
        if (questions.length > 0) {
          console.log('\x1b[33mVinyan needs clarification:\x1b[0m');
          for (const q of questions) console.log(`  • ${q}`);
          console.log();
          pendingClarifications = [...questions];
        } else {
          console.log('\n\x1b[2m(agent requested clarification but did not specify questions)\x1b[0m\n');
        }
      } else if (result.answer && !answerWasStreamed) {
        console.log(`\n${result.answer}\n`);
      } else if (result.mutations.length > 0) {
        console.log(`\n\x1b[32mModified ${result.mutations.length} file(s):\x1b[0m`);
        for (const m of result.mutations) {
          console.log(`  ${m.file}`);
        }
        console.log();
      } else if (result.status === 'failed' || result.status === 'escalated') {
        console.log(
          `\n\x1b[31m[${result.status}] ${result.escalationReason ?? result.trace?.failureReason ?? 'Unknown error'}\x1b[0m\n`,
        );
      } else {
        console.log('\n\x1b[2m(no response)\x1b[0m\n');
      }
    } catch (err) {
      // Tear down the renderer before printing the error so its buffered
      // inline block (answer / thinking) doesn't tangle with the error line.
      if (activeRenderer) {
        activeRenderer.flushSummary();
        activeRenderer.detach();
        activeRenderer = null;
      }
      console.error(`\n\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
    }

    isProcessing = false;
    turnCount++;

    // Periodic WAL checkpoint to prevent unbounded WAL file growth
    if (turnCount % 10 === 0) {
      try {
        db.checkpoint();
      } catch {
        /* best-effort */
      }
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n\x1b[2mSession saved.\x1b[0m');
    activeRenderer?.detach();
    orchestrator.close();
    db.close();
    process.exit(0);
  });

  // Graceful signal handling — second signal forces immediate exit
  let shutdownRequested = false;
  const shutdown = () => {
    if (shutdownRequested) {
      process.exit(1);
    }
    shutdownRequested = true;
    console.log('\n\x1b[2mSession saved.\x1b[0m');
    activeRenderer?.detach();
    orchestrator.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ── Command handler ────────────────────────────────────────

/**
 * Handle CLI built-in slash commands. Returns `true` if the input was
 * a built-in (and was handled), `false` otherwise — the caller should
 * then check the user-defined command registry before giving up.
 *
 * Unknown `/<name>` inputs return `false` here so the caller can fall
 * through to the user-defined registry lookup.
 */
function tryBuiltinCommand(
  input: string,
  session: { id: string },
  sessionManager: SessionManager,
  slashRegistry: SlashCommandRegistry,
  showThinking: boolean,
  setThinking: (v: boolean) => void,
): boolean {
  const cmd = input.split(/\s+/)[0]!.toLowerCase();

  switch (cmd) {
    case '/exit':
    case '/quit':
      process.emit('SIGTERM' as any);
      return true;

    case '/session':
      console.log(`  Session ID: ${session.id}`);
      console.log(`  Messages: ${sessionManager.getMessageCount(session.id)}`);
      return true;

    case '/history': {
      const history = sessionManager.getConversationHistory(session.id);
      if (history.length === 0) {
        console.log('  (no conversation history)');
      } else {
        for (let i = 0; i < history.length; i++) {
          const e = history[i]!;
          const prefix = e.role === 'user' ? '\x1b[33mYou:\x1b[0m' : '\x1b[32mVinyan:\x1b[0m';
          const text = e.content.length > 300 ? `${e.content.slice(0, 300)}...` : e.content;
          console.log(`  [${i + 1}] ${prefix} ${text}`);
        }
      }
      return true;
    }

    case '/thinking': {
      const arg = input.split(/\s+/)[1]?.toLowerCase();
      if (arg === 'on') {
        setThinking(true);
        console.log('  Thinking display: ON');
      } else if (arg === 'off') {
        setThinking(false);
        console.log('  Thinking display: OFF');
      } else {
        setThinking(!showThinking);
        console.log(`  Thinking display: ${!showThinking ? 'ON' : 'OFF'}`);
      }
      return true;
    }

    case '/clear':
      console.clear();
      return true;

    case '/commands': {
      // Phase 7d-2: list user-defined slash commands and any load errors.
      if (slashRegistry.commands.size === 0 && slashRegistry.errors.length === 0) {
        console.log('  (no user-defined slash commands — add `.vinyan/commands/<name>.md` to create one)');
      } else {
        if (slashRegistry.commands.size > 0) {
          console.log('  User-defined commands:');
          for (const [name, command] of slashRegistry.commands) {
            const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
            const desc = command.description ? ` — ${command.description}` : '';
            console.log(`    /${name}${hint}${desc}`);
          }
        }
        if (slashRegistry.errors.length > 0) {
          console.log('  Load errors:');
          for (const err of slashRegistry.errors) {
            console.log(`    ${err.file}: ${err.error}`);
          }
        }
      }
      return true;
    }

    default:
      // Not a built-in — let the caller try the user-defined registry.
      return false;
  }
}

// ── Helpers ────────────────────────────────────────────────

function parseSingleFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
