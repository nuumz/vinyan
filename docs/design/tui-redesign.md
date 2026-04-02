# Vinyan TUI — UX/UI Redesign Specification

> **Version:** 1.0
> **Date:** 2026-04-02
> **Status:** Approved for implementation
> **Scope:** Complete UX/UI overhaul of the interactive Terminal UI

---

## 1. Executive Summary

The Vinyan TUI was recently built as a custom ANSI renderer (~2,888 lines, 16 files, zero framework dependencies). While functionally complete, a comprehensive UX audit identified **19 pain points** across three categories that prevent it from being truly effective for AI agent management.

This document specifies a redesign that transforms the TUI from a static 3-tab dashboard into a **task-centric command center**, drawing interaction patterns from proven TUIs (lazygit, k9s, htop) and adapting them for the AI agent orchestration domain.

### Design Goals

1. **Easy to command** — Users can submit, monitor, and approve AI tasks with minimal friction
2. **Glanceable** — Critical status visible at all times without tab-switching
3. **Discoverable** — Context-sensitive hints eliminate the need to memorize keybindings
4. **Responsive** — Every user action produces immediate visible feedback
5. **Non-intrusive** — Alerts reach the user without hijacking their current workflow

---

## 2. Problem Analysis

### 2.1 UX Pain Points

| # | Problem | Severity | Current Behavior |
|---|---------|----------|------------------|
| 1 | Static keybinding hints | High | Status bar always shows `[?] help [q] quit` regardless of context |
| 2 | No tab badges | High | Cannot tell which tab has pending work without switching to it |
| 3 | No action feedback | High | Commands like `:approve` produce zero visual confirmation |
| 4 | Tab-locked approvals | Critical | Approval modal only auto-opens on Tasks/Dashboard tabs; missed on Peers |
| 5 | Verbose pipeline display | Medium | Full text `[1] Perceive ✓  [2] Predict ✓ ...` takes 60+ chars in task list |
| 6 | Event log trapped in dashboard | Medium | No dedicated full-screen event browsing with payload inspection |
| 7 | No PageUp/PageDown | Medium | Large event logs require dozens of `j/k` presses |
| 8 | Useless panel focus | Low | Dashboard panels 0-2 respond to focus highlight but have no keyboard interaction |
| 9 | Mode ambiguity | Medium | No clear indicator of NORMAL vs COMMAND vs FILTER mode beyond `:` prefix |
| 10 | Task list scroll broken | Medium | `selectedTaskId` by array index doesn't sync with `taskListScroll` offset |

### 2.2 Data Layer Gaps

| # | Problem | Impact |
|---|---------|--------|
| 11 | Health check incomplete | `dbPath` and `circuitBreaker` never passed — DB size always blank, breakers always show 0 |
| 12 | MetricsCollector unused | Real-time event counters (oracle, guardrail, circuit, api) computed but not displayed |
| 13 | Worker details hidden | `retired` count and `traceDiversity` computed in metrics but never rendered |
| 14 | Peer latency stale | No mechanism updates `latencyMs` after initial connection |
| 15 | Lists unsortable | Task and peer lists have no sorting or per-list filtering |

### 2.3 Architecture Debt

| # | Problem | Impact |
|---|---------|--------|
| 16 | Dual event rendering systems | `EventRenderer` (ASCII icons) vs `event-mapper.ts` (Unicode icons) — duplicated and inconsistent |
| 17 | Fake cancel | `cancelTask` sets local state only; doesn't stop the orchestrator's running task |
| 18 | Full-screen repaint | Every dirty frame writes the entire terminal buffer — flickers on busy systems |
| 19 | No minimum terminal size guard | Panels mangle at narrow terminal widths (<60 cols) |

---

## 3. New Layout Architecture

### 3.1 Unified Workspace

The new layout introduces a **5-row structure** that provides persistent context regardless of which tab is active:

```
Row 1:  Header Bar        — health + counts + clock (always visible)
Row 2:  Tab Bar           — 4 tabs with badges
Row 3+: Content Area      — left/right split (consistent across all tabs)
Row N-1: Notification Bar — pending actions OR toast feedback (collapsible)
Row N:   Context Hints    — dynamically generated keybinding hints
```

#### Full Layout Wireframe

```
┌──────────────────────────────────────────────────────────────────────────┐
│ VINYAN  ● healthy  Tasks: 2/5  Peers: 3  ⚠1              14:30:12     │
├──────────────────────────────────────────────────────────────────────────┤
│ [1]Tasks(2)   [2]System   [3]Peers(3)   [4]Events(47)                  │
├──────────────────────────────┬───────────────────────────────────────────┤
│                              │                                           │
│  PRIMARY PANE (55%)          │  DETAIL PANE (45%)                       │
│                              │                                           │
│  Navigable list with         │  Contextual detail for the               │
│  compact information         │  selected item from left pane            │
│                              │                                           │
│                              │                                           │
│                              │                                           │
│                              │                                           │
├──────────────────────────────┴───────────────────────────────────────────┤
│ ⚠ task-abc12 "Deploy auth" risk=0.87  [a]pprove [r]eject [Space]view  │
├──────────────────────────────────────────────────────────────────────────┤
│ NORMAL  j/k:nav  Enter:detail  a:approve  r:reject  ::cmd  ?:help     │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Layout Changes from Current

| Aspect | Current | New | Rationale |
|--------|---------|-----|-----------|
| Tabs | 3 (Dashboard / Tasks / Peers) | 4 (Tasks / System / Peers / Events) | Tasks is primary action; Events needs dedicated space |
| Default tab | Dashboard | Tasks | Users primarily interact with tasks |
| Panel split | Top/bottom (Tasks, Peers) or 4-quadrant (Dashboard) | Left/right on ALL tabs | Consistent mental model; matches lazygit/k9s |
| Status bar | 1 row, static hints | 3 rows: header + notification + hints | Persistent context, dynamic discoverability |
| Approval flow | Modal popup (tab-restricted) | Notification bar (global) | Approve from any tab without context switch |
| Event log | Embedded in Dashboard (1 of 4 panels) | Dedicated full-screen tab | Full browsing + payload inspection |

### 3.3 Responsive Behavior

| Terminal Width | Behavior |
|---------------|----------|
| >= 120 cols | Full layout, 55%/45% split |
| 80-119 cols | Reduced split, truncated labels |
| < 80 cols | "Terminal too small" centered message |

| Terminal Height | Behavior |
|----------------|----------|
| >= 30 rows | Full layout with all bars |
| 24-29 rows | Notification bar collapses when empty |
| < 24 rows | "Terminal too small" centered message |

---

## 4. Tab Specifications

### 4.1 Tab 1: Tasks (Default View)

The primary interaction surface. Two-pane layout: task list (left) + task detail (right).

#### Task List (Left Pane)

Each task uses **2 rows** for improved scannability:

```
┌─ Tasks (5) ──────────────────────┐
│  ID         Goal            Pipe  │
│ ▸ abc12  Deploy auth   [✓✓✓▸○○] │  <- Row 1: ID, goal, compact pipeline
│   ⚠ L2  risk:0.87         12s   │  <- Row 2: status icon, level, risk/quality, duration
│                                   │
│   def34  Refactor DB   [✓✓✓✓✓✓] │
│   ✓ L1  q:0.91           3m24s  │
│                                   │
│   ghi56  Fix tests     [✓✓▸○○○] │
│   ● L0                     45s   │
│                                   │
│   jkl78  Add logging   [✓✗○○○○] │
│   ✗ L1                   2m01s   │
└───────────────────────────────────┘
```

**Compact pipeline icons:**
- `✓` = done (green)
- `▸` = running (blue, bold)
- `○` = pending (dim)
- `⊘` = skipped (dim)

**Status icons (row 2 prefix):**
- `●` running (blue)
- `✓` completed (green)
- `✗` failed (red)
- `↑` escalated (magenta)
- `?` uncertain (yellow)
- `⚠` approval required (yellow, bold)

**Sorting:** Press `s` to cycle through sort fields:
- `startedAt` (default, newest first)
- `status` (approval > running > uncertain > completed > failed)
- `routingLevel` (highest first)
- `quality` (highest first)

#### Task Detail (Right Pane)

```
┌─ task-abc12 ──────────────────────┐
│ Goal: Deploy authentication       │
│ Source: cli  Worker: worker-3     │
│ Risk: 0.87  Level: L2            │
│                                    │
│ Pipeline:                          │
│ [1] Perceive ✓   [2] Predict ✓   │
│ [3] Plan ✓       [4] Generate ▸   │
│ [5] Verify ○     [6] Learn ○      │
│                                    │
│ Verdicts:                          │
│  ast   PASS ████████░░  0.95     │
│  type  PASS ██████░░░░  0.78     │
│  dep   FAIL ████░░░░░░  0.42     │
│                                    │
│ ⚠ APPROVAL REQUIRED               │
│ Risk: 0.87                         │
│ Reason: Mutation modifies core     │
│ Press [a] approve [r] reject       │
└────────────────────────────────────┘
```

Key improvements over current:
- **Verdict confidence gauges** — visual bars instead of just numbers
- **Full pipeline** — 2x3 grid with step names (detail view has space)
- **Contextual action hint** — shown only when applicable

### 4.2 Tab 2: System (formerly Dashboard)

Two-pane layout: health (left) + metrics (right). Replaces the 4-quadrant layout.

#### System Health (Left Pane)

```
┌─ System Health ───────────────────┐
│ Status: HEALTHY   Uptime: 2h14m  │
│                                    │
│ Database: 12.4 MB ✓               │
│ Shadow Queue: 3 ✓                 │
│ Circuit Breakers: 0 open ✓        │
│                                    │
│ Data Gates:                        │
│  ● Sleep Cycle                     │
│  ● Skill Formation                 │
│  ○ Evolution Engine                │
│  ○ Fleet Routing                   │
│                                    │
│ Real-time Counters:                │
│  oracle.verdict     284            │
│  guardrail.inject   0              │
│  circuit.open       1              │
│  api.request        1,247          │
│  session.created    3              │
└────────────────────────────────────┘
```

New: **Real-time counters** from `MetricsCollector` (currently unused in TUI).

#### Metrics & Fleet (Right Pane)

```
┌─ Metrics ─────────────────────────┐
│ Traces: 142  Task Types: 8       │
│ Success: ████████░░  82%         │
│ History: ▃▅▇▆▇█▅▇▆▇              │
│ Quality: ██████░░░░  0.71        │
│                                    │
│ Routing Distribution:              │
│  L0 ████████░░  67%    95        │
│  L1 ████░░░░░░  25%    35        │
│  L2 █░░░░░░░░░   6%     8        │
│  L3 ░░░░░░░░░░   1%     4        │
│                                    │
│ Workers: 5a  1p  0d  2r           │
│ Rules:  12a  3p  1r               │
│ Skills:  8a  2p  1d               │
│ Patterns: 34   Sleep Cycles: 7   │
│                                    │
│ Evolution:                         │
│  Quality Trend: 0.82              │
│  Routing Efficiency: 0.74         │
└────────────────────────────────────┘
```

Changes:
- Sparkline history from `successHistory[]`
- Workers show all states (active/probation/demoted/retired)
- Evolution metrics when available

### 4.3 Tab 3: Peers

Same two-pane layout. Minor updates: add sort support (`s` key cycles trust/health/lastSeen).

```
Left: Peer List                         Right: Peer Detail
┌─ Peers (3) ──────────────────────┐   ┌─ inst-02 ──────────────────────┐
│  Peer       Trust      Health    │   │ Peer: inst-02                  │
│ ▸ inst-02  trusted     ● conn   │   │ Instance: inst-02-prod         │
│   inst-05  provisional ● conn   │   │ URL: https://staging:3928      │
│   inst-09  untrusted   ◌ part   │   │                                 │
│                                   │   │ Trust: trusted  Health: conn   │
│                                   │   │ Interactions: 42  Latency: 12ms│
│                                   │   │ Last seen: 5s ago              │
│                                   │   │                                 │
│                                   │   │ Capabilities:                  │
│                                   │   │  code-generation               │
│                                   │   │  code-review                   │
│                                   │   │                                 │
│                                   │   │ Knowledge Exchange:            │
│                                   │   │  Imported: 15 patterns         │
│                                   │   │  Offered: 8 patterns           │
└───────────────────────────────────┘   └────────────────────────────────┘
```

### 4.4 Tab 4: Events (NEW)

Dedicated event browsing with payload inspection. Extracted from the dashboard's event log panel.

```
Left: Event Log                         Right: Event Detail
┌─ Events [/task] (47) ────────────┐   ┌─ Event #247 ───────────────────┐
│ 14:30:12 ✓ task    complete      │   │ Event: task:complete            │
│ 14:30:11 ⊙ oracle  verdict      │   │ Time:  14:30:12.456            │
│ 14:30:10 ⊙ oracle  verdict      │   │ Domain: task                    │
│ 14:30:08 → worker  dispatch     │   │                                 │
│ 14:30:05 ▶ task    start        │   │ Payload:                        │
│ 14:29:58 ☾ sleep   cycle        │   │ {                               │
│ 14:29:45 ★ evolve  promoted     │   │   "taskId": "abc12",           │
│ 14:29:30 ⚠ guard   injection    │   │   "result": {                  │
│ 14:29:12 ↯ circuit open         │   │     "status": "completed",     │
│ ...                               │   │     "mutations": 2,            │
│                                   │   │     "qualityScore": {          │
│                                   │   │       "composite": 0.91       │
│                                   │   │     }                          │
│                                   │   │   }                            │
│                                   │   │ }                              │
└───────────────────────────────────┘   └────────────────────────────────┘
```

Key features:
- **Full-screen event list** — no longer squeezed into 1/4 of the dashboard
- **Event detail pane** — select an event to see full JSON payload
- **Filter** — `/` filters by domain or event name (scoped to this tab)
- **Page scrolling** — `Ctrl+d`/`Ctrl+u` for fast navigation
- **Jump** — `g`/`G` to go to oldest/newest event

---

## 5. Navigation & Keybinding Design

### 5.1 Design Principles

1. **Vim-like foundation** — `j/k` navigation, `:` command mode, `/` filter
2. **Context-sensitive** — keys only shown when they do something
3. **Minimal modes** — only 3 modes (normal/command/filter), no sub-modes
4. **Progressive complexity** — basic: j/k/Enter/q; intermediate: tabs/filter/commands; advanced: sort/page-scroll/notifications

### 5.2 Global Keys (Active in All Modes)

| Key | Action | Notes |
|-----|--------|-------|
| `Ctrl+c` | Force quit | No confirmation |
| `1` / `2` / `3` / `4` | Switch tab | Tasks / System / Peers / Events |

### 5.3 Normal Mode Keys

| Key | Action | Category |
|-----|--------|----------|
| `j` / `k` / `Up` / `Down` | Navigate within focused pane | Navigation |
| `g` | Jump to top of list | Navigation |
| `G` | Jump to bottom of list | Navigation |
| `Ctrl+d` | Page down (half screen) | Navigation |
| `Ctrl+u` | Page up (half screen) | Navigation |
| `Tab` / `Shift+Tab` | Cycle between left and right pane | Focus |
| `Enter` | Select / expand item | Selection |
| `Esc` | Back / close modal / exit mode | Escape |
| `:` | Enter command mode | Mode |
| `/` | Enter filter mode (scoped to current list) | Mode |
| `?` | Toggle help overlay | Help |
| `r` | Refresh data | Action |
| `q` | Quit (confirm if tasks running) | Action |
| `Space` | Focus notification target (jump to pending approval) | Notification |

### 5.4 Context-Sensitive Keys

These keys are only active (and only shown in the hints bar) when their context applies:

| Context | Key | Action |
|---------|-----|--------|
| Task selected + approval pending | `a` | Approve task |
| Task selected + approval pending | `r` | Reject task |
| Task selected + running | `c` | Cancel task (with confirmation) |
| Notification bar has pending item | `a` / `r` | Approve/reject notification target |
| Multiple notifications pending | `[` / `]` | Cycle through notifications |
| Tasks tab focused | `n` | New task (opens `:run ` pre-filled) |

### 5.5 Command Mode (`:`)

| Command | New? | Description |
|---------|------|-------------|
| `:run "goal"` | Existing | Submit a new task |
| `:run "goal" --level 2` | **New** | Submit with explicit routing level |
| `:approve [id]` | Enhanced | Approve task (omit id = notification target) |
| `:reject [id]` | Enhanced | Reject task (omit id = notification target) |
| `:cancel [id]` | Enhanced | Cancel task (omit id = selected task) |
| `:filter <query>` | Existing | Filter current tab's list |
| `:sort <field>` | **New** | Sort current list (startedAt/status/level/quality) |
| `:clear` | Existing | Clear active filter |
| `:sleep` | Existing | Trigger sleep cycle |
| `:export [file]` | Existing | Export patterns to JSON |
| `:set <key> <value>` | **New** | Runtime configuration |

### 5.6 Context Hints Bar (Dynamic)

The bottom row dynamically renders only applicable keybindings:

```
Default (Tasks tab, no selection):
  NORMAL  j/k:nav  Enter:select  n:new  ::cmd  /:filter  ?:help

Task with pending approval selected:
  NORMAL  j/k:nav  a:approve  r:reject  Enter:detail  ::cmd  ?:help

Running task selected:
  NORMAL  j/k:nav  c:cancel  Enter:detail  ::cmd  ?:help

Command mode:
  COMMAND  Enter:execute  Esc:cancel  Tab:complete

Filter mode:
  FILTER  Enter:apply  Esc:cancel

Events tab:
  NORMAL  j/k:nav  Enter:detail  g/G:top/bottom  Ctrl+d/u:page  /:filter  ?:help
```

---

## 6. Notification & Feedback System

### 6.1 Three-Tier Architecture

The redesign introduces a layered notification system that ensures important events reach the user without disrupting their workflow:

| Tier | Location | Persistence | Purpose |
|------|----------|-------------|---------|
| **Notification Bar** | Row N-1 (above hints) | Until dismissed or resolved | Pending approvals, security alerts, critical errors |
| **Toast** | Same row as notification bar | Auto-dismiss after 3 seconds | Action feedback ("Approved", "Task submitted", "Export complete") |
| **Tab Badge** | Tab bar labels | Until user visits the tab | Unread counts, health indicator |

### 6.2 Notification Bar Behavior

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚠ task-abc12 "Deploy auth service" risk=0.87  [a]pprove [r]eject (1/3)│
└──────────────────────────────────────────────────────────────────────────┘
```

- Shows the **highest-priority** pending notification
- Persistent until the user acts on it or dismisses it
- `[` and `]` cycle through multiple pending notifications
- `(1/3)` counter shown when multiple notifications pending
- Collapses (row hidden) when no notifications are active

**Priority order:**
1. `task:approval_required` (highest)
2. `guardrail:injection_detected` / `guardrail:bypass_detected`
3. `circuit:open`
4. `observability:alert`

### 6.3 Toast Messages

When the notification bar is empty (or briefly overriding it):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ✓ Approved task-abc12                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

Toast triggers:
| Action | Toast Message |
|--------|--------------|
| `:run "goal"` | `▶ Task submitted: task-xxx` |
| Approve task | `✓ Approved task-xxx` |
| Reject task | `✗ Rejected task-xxx` |
| `:cancel id` | `⊘ Cancel requested: task-xxx` |
| `:sleep` | `☾ Sleep cycle triggered` |
| `:export file` | `✓ Exported to file` |
| `:filter query` | `/ Filtering: query` |

### 6.4 Tab Badges

```
[1]Tasks(2)   [2]System   [3]Peers(3)   [4]Events(47)
      ↑ running count       ↑ connected    ↑ new since last viewed
```

- **Tasks badge:** number of running tasks. Red if any approval pending.
- **System badge:** health dot color (green/yellow/red). No number.
- **Peers badge:** number of connected peers.
- **Events badge:** number of new events since last time Events tab was viewed. Resets on tab visit.

### 6.5 Redesigned Approval Flow

**Current flow (problematic):**
```
Bus: task:approval_required
  → Auto-open modal (ONLY if on Tasks or Dashboard tab)
  → User stuck on Peers tab → misses approval entirely
  → No feedback after approve/reject
```

**New flow:**
```
Bus: task:approval_required
  → Push to state.notifications[]
  → Notification bar renders: "⚠ task-abc12 risk=0.87 [a]pprove [r]eject"
  → Visible on ALL tabs
  → User presses [a] from ANY tab
  → orchestrator.approvalGate.resolve(taskId, 'approved')
  → Toast: "✓ Approved task-abc12" (3s auto-dismiss)
  → Notification removed; next notification shown or bar collapses
```

**Modal preserved as secondary path:** Pressing `Enter` on a task with `pendingApproval` still opens the detail modal with full risk context, pipeline state, and verdict summary.

---

## 7. Visual Language

### 7.1 Color Semantics

Consistent color meanings across all views:

| Color | ANSI | Semantic | Applied To |
|-------|------|----------|-----------|
| **Green** | `\x1b[32m` | Success / healthy / pass | Completed tasks, healthy status, PASS verdicts, trusted peers, done pipeline steps |
| **Yellow** | `\x1b[33m` | Warning / pending / caution | Approval needed, degraded health, probation, uncertain status |
| **Red** | `\x1b[31m` | Error / failure / critical | Failed tasks, unhealthy, FAIL verdicts, injection detected, untrusted peers |
| **Blue** | `\x1b[34m` | Active / running / info | Running tasks, selected items, info toasts, running pipeline step |
| **Cyan** | `\x1b[36m` | Highlight / accent | Focused panel border, selected row indicator, filter highlight, key hints |
| **Magenta** | `\x1b[35m` | Escalation / special | Escalated tasks, sleep cycle events |
| **Dim** | `\x1b[2m` | Inactive / secondary | Pending pipeline steps, timestamps, secondary text, disabled items |

### 7.2 Status Icons

| Icon | Meaning | Color |
|------|---------|-------|
| `●` | Running | Blue |
| `✓` | Completed / Pass / Done | Green |
| `✗` | Failed / Error | Red |
| `↑` | Escalated | Magenta |
| `?` | Uncertain | Yellow |
| `⚠` | Approval Required | Yellow (bold) |
| `▸` | Running (pipeline step) | Blue (bold) |
| `○` | Pending | Dim |
| `⊘` | Skipped / Cancelled | Dim |

### 7.3 Compact Pipeline Notation

For task list rows (space-constrained):

```
[✓✓✓▸○○]   — Perceive/Predict/Plan done, Generate running, Verify/Learn pending
[✓✓✓✓✓✓]   — All steps complete
[✓✗○○○○]   — Perceive done, Predict failed (escalation)
[▸○○○○○]   — Just started (Perceive running)
```

8 characters total. Each position maps to: Perceive, Predict, Plan, Generate, Verify, Learn.

### 7.4 Information Density Guidelines

| Element | Maximum Width | Content |
|---------|--------------|---------|
| Task list row 1 | Full width | ID (8) + Goal (flex) + Pipeline (8) |
| Task list row 2 | Full width | Icon (1) + Level (3) + Risk/Quality (12) + Duration (8) |
| Event log entry | Full width | Time (8) + Icon (1) + Domain (7) + Summary (flex) |
| Header bar | Full width | Logo + Health (12) + Counts (25) + Clock (8) |
| Notification bar | Full width | Icon (1) + TaskID (12) + Goal (flex) + Actions (25) |

### 7.5 Mode Indicator

Displayed at the left edge of the context hints bar:

| Mode | Display | Color |
|------|---------|-------|
| Normal | `NORMAL` | Dim white |
| Command | `COMMAND` | Blue background |
| Filter | `FILTER` | Green background |

---

## 8. Data Layer Changes

### 8.1 Wire MetricsCollector

The `Orchestrator` already instantiates a `MetricsCollector` and attaches it to the bus (see `factory.ts:330`). The TUI's `EmbeddedDataSource` needs to:

1. Access `this.orchestrator.metricsCollector`
2. In `refreshMetrics()`, copy counter values to `state.realtimeCounters`
3. Display in the System tab's health panel

### 8.2 Fix Health Check Data

Currently in `source.ts`, `getHealthCheck()` is called with only `shadowQueueDepth`. Fix:

```typescript
// Pass all available deps
this.state.health = getHealthCheck({
  shadowQueueDepth: this.state.metrics?.shadow.queueDepth ?? 0,
  dbPath: this.orchestrator.config?.dbPath,
  circuitBreaker: this.orchestrator.circuitBreaker,
});
```

### 8.3 Notification Generation

Replace auto-modal-open in `onTaskApprovalRequired()` with notification push:

```typescript
// Before: auto-open modal (tab-restricted)
// After: push notification (visible on all tabs)
state.notifications.push({
  id: state.notificationIdCounter++,
  type: 'approval',
  taskId: task.id,
  message: `"${task.goal}" risk=${riskScore.toFixed(2)}`,
  timestamp: Date.now(),
  dismissed: false,
});
```

Similarly for `guardrail:injection_detected`, `circuit:open`, and `observability:alert`.

### 8.4 Toast State Management

Add to `TUIState`:

```typescript
toasts: Array<{
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
  expiresAt: number;  // Date.now() + 3000
}>;
```

The render loop calls `cleanExpiredToasts()` each frame to remove stale toasts.

---

## 9. Screen Rendering Optimization

### 9.1 Diff-Based Rendering

Replace full-screen repaint with line-by-line diff:

```
Previous frame (stored as string[]):    New frame:
  Line 1: "VINYAN ● healthy..."         Line 1: "VINYAN ● healthy..."  (same — skip)
  Line 2: "[1]Tasks(2)..."              Line 2: "[1]Tasks(3)..."       (changed — write)
  Line 3: "▸ abc12 Deploy..."           Line 3: "▸ abc12 Deploy..."    (same — skip)
  ...
```

Only changed lines are written to stdout using `moveTo(row, 1) + lineContent`. This eliminates the full-screen flash on busy systems.

### 9.2 Running Task Timer

When any task has `status === 'running'`, set `dirty = true` every 1 second (instead of waiting for the 5-second metrics poll) so the duration display updates live.

### 9.3 Terminal Size Guard

Before rendering, check `termWidth >= 80 && termHeight >= 24`. If too small, render a centered message and skip the frame:

```
┌──────────────────────────────────┐
│  Terminal too small              │
│  Minimum: 80 x 24               │
│  Current: 62 x 18               │
│  Please resize your terminal.   │
└──────────────────────────────────┘
```

---

## 10. Implementation Phases

The redesign is implemented in 6 incremental phases. Each phase is independently deployable and backward-compatible until Phase 4 (the visible layout change).

### Phase 1: State & Types Foundation

**Goal:** Extend types and state without breaking existing code.

| File | Action | Details |
|------|--------|---------|
| `src/tui/types.ts` | Modify | Add `ViewTab='tasks'\|'system'\|'peers'\|'events'`, `NotificationEntry`, `ToastMessage`, `SortConfig`; extend `TUIState` |
| `src/tui/state.ts` | Modify | Add mutations: `pushNotification`, `dismissNotification`, `pushToast`, `cleanExpiredToasts`, `updateTabBadges`, `selectEvent` |
| `src/tui/hints.ts` | **Create** | `getContextHints(state): Array<{key, label}>` — context-sensitive hint engine (~60 lines) |
| `tests/tui/state.test.ts` | Update | Tests for new mutations |
| `tests/tui/hints.test.ts` | **Create** | Tests for context hints |

### Phase 2: Renderer Upgrades

**Goal:** Add new rendering primitives.

| File | Action | Details |
|------|--------|---------|
| `src/tui/renderer.ts` | Modify | Add `headerBar()`, `notificationBar()`, `contextHintsBar()`, `compactPipeline()`, `modeIndicator()`; update `tabBar()` for badges |
| `tests/tui/render-primitives.test.ts` | Update | Tests for new primitives |

### Phase 3: Navigation & Input Overhaul

**Goal:** Add new keybindings and actions.

| File | Action | Details |
|------|--------|---------|
| `src/tui/input.ts` | Modify | Add `TUIAction` types: `page-scroll`, `jump`, `cancel-task`, `focus-notification`; new key routes |
| `src/tui/app.ts` | Modify | Handle new actions, rewrite `renderFrame()` for new layout, add toast generation |
| `tests/tui/command-parser.test.ts` | Update | Tests for new key routes |

### Phase 4: View Rewrites (Largest Phase)

**Goal:** New layout for all tabs.

| File | Action | Details |
|------|--------|---------|
| `src/tui/views/tasks.ts` | Rewrite | 2-row task items, compact pipeline, left-right split, sort support |
| `src/tui/views/dashboard.ts` | Rename/Rewrite | Becomes `system.ts`; remove event log; add real-time counters |
| `src/tui/views/events.ts` | **Create** | Dedicated events tab with event list + payload detail (~150 lines) |
| `src/tui/views/peers.ts` | Modify | Add sort support |
| `src/tui/views/approval-modal.ts` | Modify | Add pipeline/verdict detail to modal |
| `src/tui/views/help.ts` | Rewrite | Context-sensitive help; new keybinding sections |

### Phase 5: Data Layer Fixes

**Goal:** Wire missing data sources, fix notification flow.

| File | Action | Details |
|------|--------|---------|
| `src/tui/data/source.ts` | Modify | Wire MetricsCollector; fix health check deps; generate notifications from events; remove auto-modal-open |
| `src/tui/commands.ts` | Modify | Update tab name references |

### Phase 6: Screen Optimization & Polish

**Goal:** Performance and cleanup.

| File | Action | Details |
|------|--------|---------|
| `src/tui/screen.ts` | Modify | Diff-based rendering; terminal size guard; 1-second dirty interval for running tasks |
| `src/tui/event-renderer.ts` | Modify | Delegate styling to event-mapper.ts (remove icon/color duplication) |
| `src/tui/data/event-mapper.ts` | Modify | Minor consistency updates |

---

## 11. File Summary

### Modified Files (15)

| # | File | Phase |
|---|------|-------|
| 1 | `src/tui/types.ts` | 1 |
| 2 | `src/tui/state.ts` | 1 |
| 3 | `src/tui/renderer.ts` | 2 |
| 4 | `src/tui/input.ts` | 3 |
| 5 | `src/tui/app.ts` | 3 |
| 6 | `src/tui/views/tasks.ts` | 4 |
| 7 | `src/tui/views/dashboard.ts` → `system.ts` | 4 |
| 8 | `src/tui/views/peers.ts` | 4 |
| 9 | `src/tui/views/approval-modal.ts` | 4 |
| 10 | `src/tui/views/help.ts` | 4 |
| 11 | `src/tui/data/source.ts` | 5 |
| 12 | `src/tui/commands.ts` | 5 |
| 13 | `src/tui/screen.ts` | 6 |
| 14 | `src/tui/event-renderer.ts` | 6 |
| 15 | `src/tui/data/event-mapper.ts` | 6 |

### New Files (3)

| # | File | Phase | ~Lines |
|---|------|-------|--------|
| 1 | `src/tui/hints.ts` | 1 | 60 |
| 2 | `src/tui/views/events.ts` | 4 | 150 |
| 3 | `src/tui/views/system.ts` | 4 | 180 |

### Test Files

| # | File | Phase | Action |
|---|------|-------|--------|
| 1 | `tests/tui/hints.test.ts` | 1 | Create |
| 2 | `tests/tui/state.test.ts` | 1 | Update |
| 3 | `tests/tui/render-primitives.test.ts` | 2 | Update |
| 4 | `tests/tui/command-parser.test.ts` | 3 | Update |
| 5 | `tests/tui/tui.test.ts` | 4 | Update |

---

## 12. Verification Plan

### Automated Tests

```bash
bun run check           # TypeScript type check + Biome lint
bun test tests/tui/     # All TUI-specific tests
```

### Manual Testing Checklist

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | Launch `vinyan tui` | Header bar shows health dot, task count, peer count, clock |
| 2 | Submit `:run "test"` | Toast "Task submitted", auto-switch to Tasks tab |
| 3 | Check tab badges | Tasks tab shows `(1)` for running task |
| 4 | View task list | Compact pipeline `[▸○○○○○]` visible, 2-row format |
| 5 | Wait for completion | Pipeline updates: `[✓✓✓✓✓✓]`, status icon changes to `✓` |
| 6 | Switch to System tab | Health panel shows DB size, circuit breakers, real-time counters |
| 7 | Switch to Events tab | Full event list with payload detail on right pane |
| 8 | Trigger approval | Notification bar appears on current tab (not just Tasks) |
| 9 | Press `a` from System tab | Approval resolves, toast "Approved task-xxx" shown |
| 10 | Press `g` then `G` | Jumps to top/bottom of list |
| 11 | Press `Ctrl+d` / `Ctrl+u` | Page scroll works smoothly |
| 12 | Resize terminal < 80x24 | "Terminal too small" message displayed |
| 13 | Select running task | Hints bar shows `c:cancel` |
| 14 | Press `?` | Help overlay shows context-relevant keybindings |
| 15 | Observe running task duration | Updates every ~1 second |
| 16 | Press `n` on Tasks tab | Command mode opens with `:run ` pre-filled |
| 17 | Multiple approvals pending | `[`/`]` cycles through notifications, `(1/3)` counter shown |

---

## 13. Known Limitations & Future Work

### Out of Scope for This Redesign

| Item | Reason |
|------|--------|
| Command autocomplete (Tab completion) | Requires significant parser rework; `:` commands are few enough to memorize |
| True task cancellation | Needs `AbortController` in core-loop; fake cancel (mark failed) is acceptable for now |
| Remote mode (SSE + REST) | Deferred to future phase; only embedded mode in scope |
| Mouse support | Terminal mouse events are unreliable; keyboard-first is the correct approach |
| Peer latency live updates | Requires ping mechanism in A2A transport; out of TUI scope |

### Future Enhancements (Post-Redesign)

1. **Command history** — Up/Down arrow in command mode to recall previous commands
2. **Task log view** — Press `l` on a task to see its full event history
3. **Export views** — `:screenshot` command to save current view as ANSI text
4. **Theme support** — `:set theme dark/light/minimal` for different color schemes
5. **Notification sound** — Terminal bell (`\x07`) on approval required (configurable)
