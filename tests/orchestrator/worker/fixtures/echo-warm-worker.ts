/**
 * Echo warm worker — test fixture that mimics the warm worker protocol.
 * Reads JSON lines from stdin, echoes them back to stdout with an "echo: true" field.
 */

// Signal readiness
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = '';

async function main() {
  while (true) {
    const line = await readOneLine();
    if (line === null) break;

    try {
      const input = JSON.parse(line);
      const output = { ...input, echo: true };
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
    }
  }
}

async function readOneLine(): Promise<string | null> {
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) return line;
      continue;
    }
    const { done, value } = await reader.read();
    if (done) return buffer.trim() || null;
    buffer += decoder.decode(value, { stream: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
