/**
 * Phase 7d-1: Hook executor — runs a single shell hook command with a
 * timeout, pipes the event payload to stdin as JSON, and captures stdout /
 * stderr / exit code for the dispatcher to act on.
 *
 * Protocol:
 *   stdin  — JSON payload with event + tool_name + tool_input (+ tool_output
 *            and tool_status for PostToolUse). The hook gets a single-line
 *            JSON object on stdin and can parse it with `jq`, Python, etc.
 *   stdout — optional JSON control block:
 *                { "decision": "block" | "allow", "message": "..." }
 *            Non-JSON stdout is fine; it's just captured for logging.
 *   exit   — 0 = allow, non-zero = block (PreToolUse) / warn (PostToolUse).
 *
 * The executor uses the same Bun.spawn pattern as `shell-tools.ts` but adds
 * stdin piping and a post-mortem JSON parse of the first line of stdout.
 */

export interface HookExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True if the hook was killed by the timeout. */
  timedOut: boolean;
  /** Parsed `decision` from a JSON stdout control block, if present. */
  decision?: 'block' | 'allow';
  /** Parsed `message` from a JSON stdout control block, if present. */
  message?: string;
}

export interface HookExecutionOptions {
  timeoutMs: number;
  cwd: string;
}

/**
 * Execute one hook command. Writes `stdinPayload` as JSON to the child's
 * stdin, then waits for the process to exit or the timeout to fire,
 * whichever comes first.
 */
export async function executeHook(
  command: string,
  stdinPayload: unknown,
  options: HookExecutionOptions,
): Promise<HookExecutionResult> {
  const startTime = performance.now();
  const payloadJson = JSON.stringify(stdinPayload);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['sh', '-c', command], {
      cwd: options.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    // Failure to spawn (e.g. sh missing) is reported as a non-zero exit so
    // the dispatcher's blocking logic treats it as a failed gate.
    return {
      exitCode: -1,
      stdout: '',
      stderr: `Failed to spawn hook: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Math.round(performance.now() - startTime),
      timedOut: false,
    };
  }

  // Pipe the payload to the hook's stdin. The hook is expected to read it
  // until EOF, so close stdin immediately after the write.
  try {
    const stdin = proc.stdin as unknown as { write: (data: string) => number; end: () => void };
    stdin.write(payloadJson);
    stdin.end();
  } catch {
    // Hook may have already exited before we could write — that's fine,
    // we still collect stdout/stderr and the exit code below.
  }

  const timeoutPromise = new Promise<'timeout'>((r) =>
    setTimeout(() => {
      r('timeout');
    }, options.timeoutMs),
  );

  const processPromise = (async () => {
    // When stdout/stderr are piped, Bun returns ReadableStream. The TS
    // types widen to include `number | undefined` for other pipe modes, so
    // we cast explicitly — matching the shape used by shell-tools.ts.
    const stdoutStream = proc.stdout as unknown as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as unknown as ReadableStream<Uint8Array>;
    const stdout = await new Response(stdoutStream).text();
    const stderr = await new Response(stderrStream).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  const race = await Promise.race([processPromise, timeoutPromise]);
  if (race === 'timeout') {
    try {
      proc.kill();
    } catch {
      // Already exited.
    }
    return {
      exitCode: -1,
      stdout: '',
      stderr: `hook timed out after ${options.timeoutMs}ms: ${command}`,
      durationMs: Math.round(performance.now() - startTime),
      timedOut: true,
    };
  }

  const durationMs = Math.round(performance.now() - startTime);

  // Attempt to parse an optional JSON control block from stdout. Plain-text
  // stdout (e.g. `echo "ok"`) is a legal no-op; we only care when the first
  // non-whitespace character is `{` because only then is it worth the parse.
  let decision: 'block' | 'allow' | undefined;
  let message: string | undefined;
  const trimmed = race.stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { decision?: unknown; message?: unknown };
      if (parsed.decision === 'block' || parsed.decision === 'allow') {
        decision = parsed.decision;
      }
      if (typeof parsed.message === 'string') {
        message = parsed.message;
      }
    } catch {
      // Non-JSON stdout starting with `{` (like partial JSON or logs) is
      // fine; we just ignore the parse failure and fall back to exit code.
    }
  }

  return {
    exitCode: race.exitCode,
    stdout: race.stdout,
    stderr: race.stderr,
    durationMs,
    timedOut: false,
    decision,
    message,
  };
}
