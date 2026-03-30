/**
 * Test fixture: echo oracle — reads stdin hypothesis and returns a verdict that mirrors it.
 * Used by runner tests to validate the stdio protocol.
 */
const input = await Bun.stdin.text();
const hypothesis = JSON.parse(input);

const verdict = {
  verified: true,
  type: "known",
  confidence: 1.0,
  evidence: [{ file: hypothesis.target, line: 1, snippet: `echo: ${hypothesis.pattern}` }],
  fileHashes: { [hypothesis.target]: "test-hash" },
  duration_ms: 1,
};

process.stdout.write(JSON.stringify(verdict) + "\n");
