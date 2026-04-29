/**
 * createSessionSSEStream — verifies the events that previously dropped
 * (workflow:human_input_*, workflow:step_complete) are forwarded once
 * they carry taskId and the manifest declares them sse:true.
 *
 * Reading the wire output: SSE frames are `event: <name>\ndata: <json>\n\n`.
 * We pull the first chunk, split by `\n`, and check the names directly —
 * no need for a real HTTP layer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSessionSSEStream } from '../../src/api/sse.ts';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';

let bus: VinyanBus;

beforeEach(() => {
  bus = createBus();
});

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/**
 * Prime the stream so its `start(controller)` runs and the bus
 * subscriptions register BEFORE we emit. Without this the events fire
 * into a stream whose listeners haven't attached yet — same race the
 * production session SSE protects against by subscribing to
 * `task:start` synchronously.
 *
 * Bun's `ReadableStreamDefaultReader` extends the WHATWG type with
 * `readMany`, so we expose the reader as `unknown` and cast at the
 * call site. The test only depends on the standard `read()`/`cancel()`
 * surface.
 */
interface MinimalReader {
  read: () => Promise<{ value?: Uint8Array; done?: boolean }>;
}

async function primeStream(stream: ReadableStream): Promise<MinimalReader> {
  const reader = stream.getReader() as unknown as MinimalReader;
  // First read returns the `session:stream_open` event the stream
  // emits synchronously inside start(). Once it resolves, the bus
  // listeners are attached.
  await reader.read();
  return reader;
}

async function drainFrames(reader: MinimalReader): Promise<string[]> {
  // Give the bus emit a tick to enqueue. Each `bus.emit` produces a
  // separate ReadableStream chunk (controller.enqueue is per-event)
  // so we keep racing read against a short timeout until the queue
  // goes quiet. The session stream is long-lived — we can't wait for
  // `done`.
  await Bun.sleep(5);
  const chunks: string[] = [];
  for (let i = 0; i < 16; i++) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ idle: true }>((r) => setTimeout(() => r({ idle: true }), 20)),
    ]);
    if ('idle' in result) break;
    if (result.value) chunks.push(new TextDecoder().decode(result.value));
    if (result.done) break;
  }
  return chunks
    .join('')
    .split('\n\n')
    .filter((f) => f.trim().length > 0);
}

function parseFrame(frame: string): { event?: string; payload?: unknown } {
  const lines = frame.split('\n');
  let event: string | undefined;
  let dataLine: string | undefined;
  for (const line of lines) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    else if (line.startsWith('data: ')) dataLine = line.slice('data: '.length);
  }
  if (!dataLine) return { event };
  try {
    const parsed = JSON.parse(dataLine) as { event: string; payload: unknown };
    return { event: parsed.event ?? event, payload: parsed.payload };
  } catch {
    return { event };
  }
}

describe('createSessionSSEStream forwarding', () => {
  test('forwards workflow:human_input_needed for tasks in the session', async () => {
    const { stream, cleanup } = createSessionSSEStream(bus, 'sess-1', {
      heartbeatIntervalMs: 60_000,
    });
    cleanups.push(cleanup);
    const reader = await primeStream(stream);

    // Register the task with the session via task:start.
    bus.emit('task:start', {
      input: { id: 'task-1', sessionId: 'sess-1' },
    } as never);
    bus.emit('workflow:human_input_needed', {
      taskId: 'task-1',
      sessionId: 'sess-1',
      stepId: 'step-3',
      question: 'Which file should I edit?',
    });

    const frames = (await drainFrames(reader)).map(parseFrame);
    const names = frames.map((f) => f.event);
    expect(names).toContain('workflow:human_input_needed');
  });

  test('forwards workflow:step_complete now that it carries taskId', async () => {
    const { stream, cleanup } = createSessionSSEStream(bus, 'sess-2', {
      heartbeatIntervalMs: 60_000,
    });
    cleanups.push(cleanup);
    const reader = await primeStream(stream);

    bus.emit('task:start', { input: { id: 'task-2', sessionId: 'sess-2' } } as never);
    bus.emit('workflow:step_complete', {
      taskId: 'task-2',
      sessionId: 'sess-2',
      stepId: 's1',
      status: 'completed',
      strategy: 'direct-tool',
      durationMs: 12,
      tokensConsumed: 0,
    });

    const frames = (await drainFrames(reader)).map(parseFrame);
    expect(frames.map((f) => f.event)).toContain('workflow:step_complete');
  });

  test('does NOT forward workflow:step_complete from a sibling session', async () => {
    const { stream, cleanup } = createSessionSSEStream(bus, 'mine', {
      heartbeatIntervalMs: 60_000,
    });
    cleanups.push(cleanup);
    const reader = await primeStream(stream);

    // task-other belongs to a different session; the membership filter
    // on the manifest-derived list should suppress it.
    bus.emit('task:start', { input: { id: 'task-other', sessionId: 'theirs' } } as never);
    bus.emit('workflow:step_complete', {
      taskId: 'task-other',
      sessionId: 'theirs',
      stepId: 's1',
      status: 'completed',
      strategy: 'direct-tool',
      durationMs: 5,
      tokensConsumed: 0,
    });

    const frames = (await drainFrames(reader)).map(parseFrame);
    // The membership filter should suppress the cross-session event;
    // the only thing left would be `task:start` (also suppressed since
    // it does not match our session).
    expect(frames.map((f) => f.event)).not.toContain('workflow:step_complete');
  });

  test('forwards workflow:human_input_provided as a session event', async () => {
    const { stream, cleanup } = createSessionSSEStream(bus, 'sess-3', {
      heartbeatIntervalMs: 60_000,
    });
    cleanups.push(cleanup);
    const reader = await primeStream(stream);

    bus.emit('task:start', { input: { id: 'task-3', sessionId: 'sess-3' } } as never);
    bus.emit('workflow:human_input_provided', {
      taskId: 'task-3',
      sessionId: 'sess-3',
      stepId: 's2',
      value: 'src/foo.ts',
    });

    const frames = (await drainFrames(reader)).map(parseFrame);
    expect(frames.map((f) => f.event)).toContain('workflow:human_input_provided');
  });
});
