"""build_verdict() — convenience helper for constructing validated OracleVerdict instances."""

from __future__ import annotations

from typing import Any

from .schemas import Evidence, OracleVerdict


def build_verdict(
    *,
    verified: bool,
    evidence: list[dict[str, Any] | Evidence],
    file_hashes: dict[str, str],
    duration_ms: float,
    **kwargs: Any,
) -> OracleVerdict:
    """Build and validate an OracleVerdict.

    Args:
        verified: Whether the hypothesis was verified.
        evidence: Evidence chain (dicts or Evidence instances).
        file_hashes: Content-addressed file hashes.
        duration_ms: Execution duration in milliseconds.
        **kwargs: Additional verdict fields (type, confidence, reason, etc.).

    Returns:
        A validated OracleVerdict instance.

    Raises:
        pydantic.ValidationError: If the verdict fails schema validation.
    """
    evidence_objs = [
        e if isinstance(e, Evidence) else Evidence.model_validate(e)
        for e in evidence
    ]

    return OracleVerdict.model_validate(
        {
            "verified": verified,
            "evidence": evidence_objs,
            "file_hashes": file_hashes,
            "duration_ms": duration_ms,
            **kwargs,
        }
    )
