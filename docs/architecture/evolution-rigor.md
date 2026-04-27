# Evolution & Sleep-Cycle Statistical Rigor

Reference for code under `src/evolution/` and `src/sleep-cycle/`.

## When to use

You are about to:

- Add or modify a rule generator under `src/evolution/` or `src/sleep-cycle/`.
- Write a function that scores candidate rules from observed traces.
- Add a backtester or modify how a candidate is shadow-tested.
- Implement a promotion gate — the boundary between candidate and active rule.
- Change how rule outcomes are recorded for future evaluation, or how prediction-error is computed.
- Author a sufficiency / data-gate check.

## Read first

- The current code under `src/evolution/` and `src/sleep-cycle/`.
- Any existing Wilson, decay, or backtest helpers — reuse before re-implementing.
- The trace store and prediction-error tracking conventions.

Specific sample-size thresholds, half-life constants, and Wilson Z-values are configuration, not principles — verify by reading. Do not paste from memory.

## Invariants (mathematical, stable)

- **Use confidence intervals, not point estimates.** For success/failure proportions, the lower bound of a Wilson interval (or equivalent calibrated bound) is the promotion criterion — not raw `successes / total`. With small samples, point estimates lie; Wilson CI calibrates uncertainty by sample size.
- **Weight recent evidence more.** Use exponential decay or an equivalent time-weighted scheme. Never treat a trace from six months ago equally to one from yesterday.
- **Backtest before promote.** A candidate rule runs against historical traces in shadow mode and produces a prediction-error metric before it is allowed onto the live routing path. No exceptions for rules that "obviously" look fine.
- **Sufficiency gates uncertainty (A2).** When the sample is too small to support a confident decision, emit the protocol's `unknown` state and abstain. Do not promote on under-powered data; do not substitute a default.
- **Prediction error is the learning signal (A7).** Every promoted rule logs its prediction; reality validates it; the delta drives both ongoing weighting and eventual retirement. Plain success/failure booleans are insufficient.
- **Generation ≠ promotion (A1).** The component that proposes a candidate rule is not the one that promotes it. Promotion belongs to a rule-based gate, never to the generator.
- **No LLM in the promotion gate (A3).** The decision to promote is deterministic and reproducible from the score and the gate parameters. An LLM may help propose candidates; it does not decide whether they ship.
- **Every promotion has a retirement path.** A rule that can be promoted can be retired by the same mechanism. Never promote a rule without a way to take it back.

## Required around any promotion gate

- Lower-bound a confidence interval on the proportion being measured.
- Apply temporal weighting; do not flat-average traces.
- Run the backtest harness and record prediction-error before the gate fires.
- Check sufficiency; if not met, abstain (emit `unknown`).
- Persist trace and shadow records before the promotion completes — same crash-safety ordering as the rest of the orchestrator. See `vinyan-phase-wiring`.
- Log the promotion decision deterministically; the score, the threshold, and the gate outcome all reproducible from inputs.

## Anti-patterns this skill catches

- `successes / total > THRESHOLD → promote` — the point-estimate trap. Small samples will hit this almost arbitrarily.
- Mean across all historical traces with no decay.
- A generator that promotes its own candidates based on its own prediction (self-validation, A1 violation).
- A "fast path" that skips the backtest because the rule is small or local.
- Returning a default verdict when the sample is insufficient, instead of the protocol's `unknown` state.
- Promoting a rule with no way to retire it, or where retirement requires a manual code change.
- An LLM call inside the promotion gate to "sanity check" whether the rule looks reasonable — A3 violation.

## What this skill does NOT do

- Tell you current sample-size thresholds, decay constants, or Wilson Z values — those are configuration. Read the code.
- Cover the broader epistemic-separation question (who is allowed to propose vs who promotes) — see `vinyan-axioms`.
- Replace `vinyan-phase-wiring` for crash-safety / ordering invariants when the promotion writes through the orchestrator.
- Cover capability-claim semantics or the runtime-skill trust ledger — those have their own surfaces. See `vinyan-runtime-skills` for trust-ledger discipline.
