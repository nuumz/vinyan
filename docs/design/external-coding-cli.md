# External Coding CLI Control-Plane

**Status:** Phase 1 + 2 shipped (2026-04-30).

- **Phase 1** (backend): common controller, both adapters, headless verification, persistence, API surface, workflow strategy.
- **Phase 2** (UI + hardening): vinyan-ui integration (provider badge, live activity card, approval card, result + verification card, SSE reducer), workflow executor `dispatchStrategy` case wired, chokidar workspace watcher for wrapper-mode hooks, `streamProtocol` capability flag + interactive routing guard.

**Source code:**
- Backend: `src/orchestrator/external-coding-cli/`, `src/db/coding-cli-store.ts`, `src/db/migrations/024_coding_cli.ts`, `src/api/coding-cli-routes.ts`.
- Workflow: `src/orchestrator/workflow/workflow-executor.ts` (case `external-coding-cli`), `src/orchestrator/workflow/types.ts` (strategy union).
- UI: `vinyan-ui/src/lib/api-client.ts` (`api.codingCli.*`), `vinyan-ui/src/hooks/coding-cli-state.ts` (substate reducer), `vinyan-ui/src/components/chat/coding-cli-{card,approval-card,result,shared}.tsx`.
- Tests: `tests/orchestrator/external-coding-cli/` (72 backend tests), `vinyan-ui/src/hooks/coding-cli-state.test.ts` (11 UI reducer tests).

---

## What this is

One control-plane drives heterogeneous CLI coding agents. Today: **Claude Code**, **GitHub Copilot CLI** (when present). Tomorrow: anything else that exposes a terminal coding agent. The thesis is that "Claude Code integration" and "Copilot integration" are the *same problem* — start a process, capture decisions, gate approvals, verify the claim — so we build it once.

```
Vinyan ──► ExternalCodingCliController ──► ProviderAdapter (per CLI)
              │                                  │
              ├── session lifecycle              ├── binary detection
              ├── state machine                  ├── command flags / quirks
              ├── approval bridge                ├── stdin/stdout protocol
              ├── hook bridge                    ├── native hook config
              ├── result parser                  ├── approval-prompt parsing
              └── Vinyan verification gate       └── approval reply mechanics
```

Generation is the CLI's job. **Verification is Vinyan's** (A1).

## Axioms in this subsystem

| Axiom | How this code honors it |
|---|---|
| **A1** Epistemic separation | The CLI emits a `<CODING_CLI_RESULT>` self-claim; `CodingCliVerifier` runs git-diff/test/oracle checks before the controller marks `completed`. Phantom file claims fail verification. |
| **A3** Deterministic governance | Routing is `pickProvider({needs...})` over the cached capability matrix — pure function of detection state. State machine transitions are data-driven and throw on illegal moves. |
| **A6** Zero-trust execution | The CLI is a worker, never an authority. Approval policy defaults to require-human for writes, shell, and git. `--dangerously-skip-permissions` requires *both* operator-level AND task-level explicit opt-in. |
| **A7** Prediction error as learning | When the CLI says `claimedPassed: true` but Vinyan verification fails, `coding-cli:verification_completed` carries `predictionError: { claimed, actual, reason }` for ledger replay. |
| **A8** Traceable accountability | Every event (`coding-cli:*`) is recorded with `taskId` and `codingCliSessionId`. Approvals/decisions land in dedicated tables (`coding_cli_approvals`, `coding_cli_decisions`). Hook events are persisted JSONL. |
| **A9** Resilient degradation | Stalled detector + wall-clock timeout + provider-not-available → `unsupported-capability` instead of pretending. Wrapper hook bridge synthesizes events when native hooks are absent. Provider crash exits cleanly via SIGTERM→SIGKILL. |

## Capability matrix (verified locally on 2026-04-30)

| Capability                  | Claude Code v2.1.123 | gh copilot wrapper v2.89.0 | Standalone Copilot CLI |
| --------------------------- | -------------------- | -------------------------- | ---------------------- |
| Binary on PATH              | ✅ `claude`         | ✅ `gh copilot`           | (variable — needs install via `gh copilot`) |
| Headless one-shot           | ✅ `-p`             | ✅ `-p "..."`             | ✅ `-p "..."`         |
| Stream-json input/output    | ✅                  | ❌                         | ❌                     |
| Native lifecycle hooks      | ✅ via `--settings`+`--include-hook-events` | ❌                         | ❌                     |
| `--include-partial-messages`| ✅                  | ❌                         | ❌                     |
| Tool gating                 | ✅ `--allowedTools` / `--disallowedTools` / `--permission-mode` | ✅ `--allow-tool 'shell(git)'` | ✅                  |
| Resume / continue           | ✅ `-r`/`-c`        | (per session, untested)    | (per session)          |
| `--session-id <uuid>`       | ✅                  | ❌                         | ❌                     |
| Default permission mode     | safe (`default`)     | safe (interactive prompt)  | (variable)             |

**Gotcha:** the path `~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot` exists on this machine but it's the VS Code extension's wrapper which prints `Cannot find GitHub Copilot CLI / Install GitHub Copilot CLI?` if you run it standalone. The adapter recognizes that string and reports `available: false` rather than spawning a CLI that hangs at an install prompt.

## Honest disclosure (when capability is missing)

The Copilot adapter does not silently degrade to "limited" mode if the install variant cannot do code editing. Instead, the controller transitions the session to `unsupported-capability` and the workflow outcome is `status: 'unsupported'`. This is A1 — never claim a capability we cannot deliver.

## State machine

`created → starting → ready → running → {planning|editing|running-command|waiting-input|waiting-approval|verifying} → {completed|failed|cancelled|timed-out|crashed|stalled|unsupported-capability}`

Transitions are data-driven (`external-coding-cli-state-machine.ts`). Illegal moves throw. Replay reconstructs state from history.

## Modes

1. **Headless** — one-shot prompt → result. Requires capability `headless`. Used for isolated tasks (write a function, fix a bug, run a review).
2. **Interactive** — persistent session over stdin/stdout streams. Requires capability `interactive`. We do NOT use a real PTY today; we drive Claude via its stream-json SDK protocol (`--print --input-format=stream-json --output-format=stream-json`), which is the canonical machine driver and does not require a TTY. For providers that hard-require a TTY this is the documented PTY upgrade path.
3. **Limited** — degraded variant (e.g. `gh copilot suggest` only). Marked `unsupported-capability` for autonomous code-edit routing unless the operator explicitly opts in.

## Hook bridge

Three modes per provider, configured via `codingCli.providers.<id>.hookBridge.mode`:

- **native**: provider's lifecycle hooks (Claude Code's settings.json) write JSONL to a per-session sink. The runner drains it.
- **wrapper**: no native hooks; we synthesize hook-shaped events from stdout parsing + filesystem watching. Tagged `_wrapperSynthesized: true` so consumers can distinguish provenance (A5 tiered trust).
- **hybrid** (default for Claude Code): both — native preferred, wrapper fills gaps.
- **off**: no hook ingestion (degraded).

The Claude adapter's `setupHookBridge` writes a temp `settings.json` and a shim shell script — it does NOT touch the user's persistent `~/.claude/settings.json`.

## Approval policy chain (deterministic)

In order:

1. `allowDangerousSkipPermissions: true` at task level → auto-approve (operator-explicit YOLO).
2. Git mutations (`git commit/push/tag/...` etc) → require human, **regardless** of any other config (matches `~/.claude/CLAUDE.md` hard rule).
3. `requireHumanForShell` + scope=shell → require human, unless command is read-only AND `autoApproveReadOnly` is true.
4. `requireHumanForWrites` + scope ∈ {edit, tool} → require human.
5. Default: require human (default-deny posture).

`auto-approve` requests are NEVER prompted to the user. `require-human` requests block on `ApprovalGate.requestApproval`, which is resolved by the API/TUI/operator. Timeouts auto-reject.

## Result contract

The CLI is asked (via the system prompt) to emit exactly one block:

```
<CODING_CLI_RESULT>
{ "status":"completed", "providerId":"claude-code", "summary":"...", ... }
</CODING_CLI_RESULT>
```

The parser:
- Takes the **last** valid block (handles draft-then-final).
- Rejects provider-id mismatch (claude-code claiming to be github-copilot is an A6 violation).
- Validates against `CodingCliResultSchema`.
- Returns `null` when no valid block exists — caller treats null as "result not yet emitted" or "fail" depending on context.

**Importantly, parsing succeeds ≠ acceptance.** The verifier runs after parsing and may reject the claim.

## Verification (the A1 boundary)

`CodingCliVerifier.verify(claim)` runs three checks:

1. **Git diff sanity** — does `git status --porcelain` match `claim.changedFiles`? Phantom claims (CLI says it edited a file that doesn't exist) and silent edits (CLI changed files it didn't disclose) both fail.
2. **Test command** — when configured, runs the operator-supplied test command and parses pass/fail counts. Failure flips the verdict regardless of `claimedPassed`.
3. **Goal alignment oracle** — pluggable callback that receives changed files and returns ok/not. Used for cross-file consistency or repo-specific rules.

When `claim.verification.claimedPassed === true` but verification fails, `predictionError = true` is recorded for A7 calibration learning.

## API surface

Mounted at `/api/v1/coding-cli/*`:

- `GET    /providers` — capability matrix per provider (cached 60s; `?refresh=1` to force).
- `POST   /sessions` — create session (body: `{ task, providerId?, headless? }`).
- `GET    /sessions` — live + persisted sessions.
- `GET    /sessions/:id` — single session detail.
- `POST   /sessions/:id/message` — follow-up text.
- `POST   /sessions/:id/approve` — body: `{ taskId, requestId }`.
- `POST   /sessions/:id/reject` — body: `{ taskId, requestId }`.
- `POST   /sessions/:id/cancel` — body: `{ reason? }`.
- `GET    /sessions/:id/events` — paginated event log.
- `POST   /run` — headless one-shot with verification.

## Bus events (provider-neutral)

Every UI-visible event is in `EVENT_MANIFEST` with `scope: 'task'`, `sse: true`, `record: true`:

```
coding-cli:session_created       coding-cli:approval_required
coding-cli:session_started       coding-cli:approval_resolved
coding-cli:state_changed         coding-cli:decision_recorded
coding-cli:message_sent          coding-cli:checkpoint
coding-cli:output_delta          coding-cli:result_reported
coding-cli:tool_started          coding-cli:verification_started
coding-cli:tool_completed        coding-cli:verification_completed
coding-cli:file_changed          coding-cli:completed
coding-cli:command_requested     coding-cli:failed
coding-cli:command_completed     coding-cli:stalled
                                 coding-cli:cancelled
```

Every payload extends `CodingCliEventBase` (taskId + sessionId + codingCliSessionId + providerId + state + ts) — enforced by manifest contract test.

## Persistence

Migration `024_coding_cli.ts` adds four tables: `coding_cli_sessions`, `coding_cli_events`, `coding_cli_approvals`, `coding_cli_decisions`. Sessions upsert on update; events/approvals/decisions are append-only.

## Configuration

```ts
codingCli: {
  enabled: false,                           // gate the whole subsystem
  defaultProvider: 'auto',                  // or 'claude-code' | 'github-copilot'
  mode: 'auto',                             // headless | interactive | auto
  timeoutMs: 15 * 60 * 1000,
  idleTimeoutMs: 2 * 60 * 1000,
  maxOutputBytes: 4 * 1024 * 1024,
  providers: {
    claudeCode: {
      enabled: true,
      binaryPath: undefined,                // PATH lookup
      allowDangerousSkipPermissions: false, // operator opt-in for YOLO
      hookBridge: { enabled: true, mode: 'hybrid' },
    },
    githubCopilot: {
      enabled: true,
      legacyGhCopilotFallback: true,
      hookBridge: { enabled: true, mode: 'wrapper' },
    },
  },
  permissions: {
    autoApproveReadOnly: false,
    requireHumanForWrites: true,
    requireHumanForShell: true,
    requireHumanForGit: true,
  },
}
```

## Safety model

- **argv arrays only** — no shell string concatenation, no spawn from user input.
- **env allow-list** — adapters do NOT inherit `process.env`. Each lists exactly which env vars to forward (PATH, HOME, ANTHROPIC_API_KEY, GH_TOKEN, etc).
- **cwd guard** — `TranscriptReader` blocks path traversal, refuses symlinks, caps file size.
- **YOLO is opt-in** — `--dangerously-skip-permissions` requires both adapter-level AND task-level explicit opt-in.
- **No commit without authorization** — git mutations always require human approval.
- **Output bounded** — captured stdout/stderr is capped per session (`maxOutputBytes`) with head-drop tail-keep eviction.
- **PID lifecycle** — cancel sends SIGTERM, then SIGKILL after a 5-second grace.

## PTY policy

We do **not** ship a real PTY. Both providers we support drive cleanly without one:

- **Claude Code** uses `--print --input-format=stream-json --output-format=stream-json` — stream protocol over pipes, no TTY required.
- **GitHub Copilot** uses `gh copilot -p "prompt"` (or standalone `copilot -p`) — headless by design.

The new `streamProtocol` capability flag declares this honestly. The controller's routing guard refuses to route `mode: 'interactive'` to a provider whose capability is `interactive: true && streamProtocol: false` — a TTY-only CLI over pipes silently hangs on `isatty()` checks, and pretending otherwise is an A1 violation.

**Falsifiable trigger to revisit:** if we add a provider whose interactive mode cannot be served by a stream protocol, we add a NEW process backend (e.g. `PtyProcess` next to `PipeProcess`) gated by a config flag. We do not monkey-patch `external-coding-cli-pty-adapter.ts`. Until then, `interactive` requests on TTY-only providers transition to `unsupported-capability` with a clear reason.

`FORCE_COLOR` and `NO_COLOR` are passed through both adapters' env allowlists so users can opt into colored output without the controller setting it as a default.

## Wrapper-mode workspace watcher

Providers without native lifecycle hooks (Copilot today) get live `file_changed` wrapper events from a `chokidar` watch over the session's `cwd`. Default-ignored: `.git`, `node_modules`, `.vinyan`, `.bun`, `dist`. Per-path 250 ms throttle dedupes editor atomic-write cascades. Symlinks not followed. CI sandboxes without inotify degrade silently — post-run `git status --porcelain` still catches changes.

## Workflow integration

`workflow-executor.ts` has a `case 'external-coding-cli':` arm. When a workflow step's `strategy` is `external-coding-cli`, the executor calls `deps.codingCliStrategy.run(...)`, which delegates to the controller's headless run (with verification). Step input keys recognized: `providerId`, `mode`, `notes`, `model`. Outcome status mapping:

| `CodingCliWorkflowOutcome.status` | Workflow step `status` |
| --------------------------------- | ---------------------- |
| `completed`                       | `completed`            |
| `failed`                          | `failed`               |
| `unsupported`                     | `failed` (operator should fall back via `fallbackStrategy`) |
| `cancelled`                       | `failed`               |

A1 verification runs INSIDE the strategy adapter — the workflow layer never sees an unverified "completed" CLI claim.

## UI integration

`vinyan-ui` ships three new components and a substate reducer:

- `<CodingCliCard>` — one row per active or recently-completed CLI session, with provider badge, state chip, compact tool/file/command activity row, expandable drawer with full lists. Mirrors the structural pattern of `<AgentTimelineCard>`.
- `<CodingCliApprovalCard>` — inline approval prompt for CLI-raised permission requests. Calls `api.codingCli.approve` / `reject`. Red palette for `require-human` policy decisions, yellow for `auto-approve` audits.
- `<CodingCliResult>` — final-result envelope + Vinyan verification verdict. When CLI claimed pass but Vinyan disagreed, the card renders a "prediction error" badge (A7 signal).
- `coding-cli-state.ts` — pure substate reducer (`reduceCodingCliSessions`) folded into `StreamingTurn.codingCliSessions` keyed by `codingCliSessionId`. Caps: 16 KiB output buffer, 50 tool entries, 200 file paths, 50 commands, FIFO eviction.
- Slot order in `StreamingBubble`: `TurnHeader → InterruptBanner → PartialDecisionCard → AgentTimelineCard → CodingCliCard → PlanSurface → ProcessTimeline → FinalAnswer → DiagnosticsDrawer`.

SSE flow: every `coding-cli:*` event flows through `useSSESync.handleEvent` → `ingestGlobal(event)` → `reduceTurn(turn, event)` → `reduceCodingCliSessions`. Critical events (`approval_required`, `failed`, `stalled`) raise toasts.

## Still future work

- **Native Copilot hooks** — none exist today. If GitHub publishes a hook protocol, the adapter can swap `mode: 'wrapper'` → `mode: 'native'` without touching the controller.
- **Real PTY** — see PTY policy above. Adding it is a NEW backend, not a monkey-patch. Wait for a concrete provider that requires it.
- **Approval timeout countdown** in `<CodingCliApprovalCard>` — current card omits the timer because the backend's `ApprovalGate` timeout is a hard 5-minute auto-reject; surfacing a countdown matches `<WorkflowApprovalCard>`'s pattern and is a small follow-up.
- **Persistence of resolved approvals on the server** — they're persisted via `coding_cli_approvals` rows by the controller, but the API doesn't yet emit a "list resolved approvals" endpoint.
- **Cancellation from the UI** — `api.codingCli.cancel` exists; surfacing a cancel button in `<CodingCliCard>` is a small UI follow-up.
