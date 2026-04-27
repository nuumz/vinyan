---
name: vinyan-bun-test
description: Run Bun tests in this repo without hanging the terminal or running the wrong scope. Trigger any time you are about to invoke `bun test` or `bun run test*`. Use BEFORE constructing the command line.
---

## When to use

Any time you would run `bun test`, `bun run test`, `bun run test:integration`, `bun run test:smoke`, or `bun run test:benchmark`.

## Hard rules (terminal will hang otherwise)

- **No `2>&1`.** Bun's TTY progress writer collides with merged stderr — terminal hangs.
- **No pipes.** `| tee`, `| cat`, `| grep` cause the same hang. Use the runner's own filters instead.
- **Always scope to a file or pattern.** Default to `bun test tests/path/to/file.test.ts`. Run the full suite only when shared types changed.
- **Set an explicit timeout** when a hang is even mildly plausible: `--timeout 30000`.
- **Do not retry in a tight loop** when a test hangs. A hung test is a signal; diagnose first.

## Filtering (use these instead of pipes)

- File scope: pass the path positionally.
- Test name: `-t "<pattern>"`.
- Reporter: `--reporter=<name>` if default output is too noisy.

## Real-LLM gates (definition of done)

- Mock-only tests do not prove the system works. Before declaring a session done, run `bun run test:smoke` with a real API key.
- Run `bun run test:benchmark` before merging changes to phases / core-loop / perception / agent-loop.
- A green unit suite with no smoke run is **not** a green light to commit-or-mark-done.

## Anti-patterns this skill catches

- `bun test 2>&1 | tee /tmp/out.log`
- `bun run test:all` to debug a single file change
- Re-running a hung test instead of timing it out
- Declaring a feature done with mocks only
- Reaching for `cat` / `head` to inspect test output instead of letting the runner write to stdout
