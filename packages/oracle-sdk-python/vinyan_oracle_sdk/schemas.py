"""ECP Schemas — Pydantic v2 models mirroring the TypeScript Oracle SDK.

These are the canonical Python models for the Epistemic Communication Protocol (ECP).
Oracles read HypothesisTuple from stdin and write OracleVerdict to stdout.

Field naming: snake_case in Python, camelCase in JSON (via alias_generator).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _CamelModel(BaseModel):
    """Base model with camelCase JSON serialization."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


# ── Input Schema ──────────────────────────────────────────────────────


class HypothesisTuple(_CamelModel):
    """What the oracle should verify."""

    target: str
    """Target file or symbol to verify."""

    pattern: str
    """Verification pattern (e.g., 'type-check', 'symbol-exists', 'import-exists')."""

    context: dict[str, Any] | None = None
    """Optional context key-value pairs."""

    workspace: str
    """Workspace root directory."""


# ── Evidence Schema ───────────────────────────────────────────────────


class Evidence(_CamelModel):
    """A source location with a diagnostic snippet."""

    file: str
    """File path (relative to workspace)."""

    line: int
    """Line number (1-based)."""

    snippet: str
    """Diagnostic message or code snippet."""

    content_hash: str | None = None
    """Optional SHA-256 hash of the file content (A4: content-addressed truth)."""


# ── Quality Score Schema ──────────────────────────────────────────────


class QualityScore(_CamelModel):
    """Multi-dimensional quality signal.

    Cross-language drift fix (2026-04-15): `phase` was renamed from
    'phase0'/'phase1'/'phase2' to 'basic'/'extended'/'full' in the TS
    source + TS SDK. The Python SDK was left behind. Without this fix,
    messages produced by the Python SDK would fail the TS orchestrator's
    Zod validation because the phase values are in the wrong vocabulary.
    """

    architectural_compliance: float
    efficiency: float
    simplification_gain: float | None = None
    test_mutation_score: float | None = None
    composite: float
    dimensions_available: int = 2
    phase: Literal["basic", "extended", "full"] = "basic"


# ── Error Code ────────────────────────────────────────────────────────

OracleErrorCode = Literal[
    "TIMEOUT",
    "PARSE_ERROR",
    "TYPE_MISMATCH",
    "SYMBOL_NOT_FOUND",
    "ORACLE_CRASH",
    "BUILD_FAILED",
    "VET_VIOLATION",
    "MODULE_UNTIDY",
    "BORROW_CHECK",
    "LIFETIME_ERROR",
    "TRAIT_NOT_SATISFIED",
    "UNSAFE_VIOLATION",
    "UNSUPPORTED_PATTERN",
]


# ── ECP Extensions ────────────────────────────────────────────────────


class DeliberationRequest(_CamelModel):
    """Oracle requests more budget for deeper analysis."""

    reason: str
    suggested_budget: float


class TemporalContext(_CamelModel):
    """Validity window for time-bounded verdicts."""

    valid_from: float
    valid_until: float
    decay_model: Literal["linear", "step", "none"]


# ── Output Schema ─────────────────────────────────────────────────────


class OracleVerdict(_CamelModel):
    """The verification result with evidence chain."""

    verified: bool
    """Whether the hypothesis was verified."""

    type: Literal["known", "unknown", "uncertain", "contradictory"] = "known"
    """Epistemic state."""

    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    """Confidence level [0, 1]. 1.0 for deterministic oracles."""

    evidence: list[Evidence]
    """Evidence chain — source locations supporting the verdict."""

    falsifiable_by: list[str] | None = None
    """Conditions that would falsify this verdict."""

    file_hashes: dict[str, str]
    """Content-addressed file hashes (A4)."""

    reason: str | None = None
    """Human-readable reason for failure."""

    error_code: OracleErrorCode | None = None
    """Programmatic error code."""

    oracle_name: str | None = None
    """Oracle name — attached by runner, not by oracle process."""

    duration_ms: float
    """Execution duration in milliseconds."""

    quality_score: QualityScore | None = None
    """Multi-dimensional quality signal."""

    deliberation_request: DeliberationRequest | None = None
    """Request for deliberation (more budget)."""

    temporal_context: TemporalContext | None = None
    """Temporal validity context."""
