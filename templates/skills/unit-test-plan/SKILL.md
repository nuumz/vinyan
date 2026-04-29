---
name: unit-test-plan
description: Outline unit tests for a function or module before writing them. Use when the goal mentions writing tests, test plan, or test coverage.
---

# Unit Test Plan

Outline the cases first; write code second. Test code that codifies the contract is more valuable than test code that incidentally passes.

## When to use

- The user asks for a test plan, test coverage, or to add tests for a function/module.
- You're about to write tests but haven't enumerated the cases yet.
- Reviewing a test file that misses obvious branches.

## Procedure

1. **Read the function / contract first.** What's its input domain? What does it promise to return? What does it promise *not* to do?
2. **Enumerate behavioural cases**, not lines of code:
   - **Happy path** — the most common, well-formed input.
   - **Boundary** — empty input, max input, exact threshold values, edges of accepted ranges.
   - **Invalid** — malformed, wrong type, out-of-range; what should happen? (throw? return null? sentinel?)
   - **State / side effects** — does the function mutate? observable side effects? idempotency?
   - **Error paths** — the *expected* failure modes (timeout, permission, dep failure).
3. **For each case, write the assertion before the arrangement.** What output proves the case is handled? If you can't state the assertion clearly, you don't understand the case yet.
4. **Avoid behaviour-free assertions.** `expect(x).toHaveProperty('foo')` proves the shape, not the behaviour. Prefer assertions that would fail if the function silently no-op'd.
5. **Per-case → per-test.** One assertion per test (or tightly related ones) keeps failure messages diagnostic.

## Format

```
Function: <name>
Contract: <what it promises>

Cases:
1. happy path:   given X, returns Y
2. empty input:  given [], returns sentinel (no throw)
3. boundary:     given length === MAX, succeeds; MAX+1 throws BoundaryError
4. invalid type: given <wrong shape>, throws ValidationError with field path
5. side effect:  on success, calls store.write exactly once with hashed key
```

## Anti-patterns to avoid

- **Mocking the unit under test.** If the test mocks the function it's testing, it tests the mock.
- **Asserting on intermediate state.** Assert on the contract output, not on the order of internal calls (unless the order *is* the contract).
- **One giant test that exercises five cases.** First failure hides the rest.
- **Snapshot tests for contract code.** Snapshots are good for stable rendering; they're noise for logic.
