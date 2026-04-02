"""Tests for build_verdict() helper."""

import pytest
from pydantic import ValidationError

from vinyan_oracle_sdk import build_verdict
from vinyan_oracle_sdk.schemas import Evidence


class TestBuildVerdict:
    def test_minimal(self):
        v = build_verdict(
            verified=True,
            evidence=[{"file": "f.ts", "line": 1, "snippet": "ok"}],
            file_hashes={"f.ts": "a" * 64},
            duration_ms=42,
        )
        assert v.verified is True
        assert v.type == "known"
        assert v.confidence == 1.0
        assert len(v.evidence) == 1

    def test_with_evidence_objects(self):
        v = build_verdict(
            verified=False,
            evidence=[Evidence(file="f.ts", line=1, snippet="err")],
            file_hashes={"f.ts": "a" * 64},
            duration_ms=10,
            reason="type mismatch",
        )
        assert v.verified is False
        assert v.reason == "type mismatch"

    def test_with_kwargs(self):
        v = build_verdict(
            verified=True,
            evidence=[{"file": "f.ts", "line": 1, "snippet": "ok"}],
            file_hashes={"f.ts": "a" * 64},
            duration_ms=42,
            type="uncertain",
            confidence=0.7,
            error_code="TYPE_MISMATCH",
        )
        assert v.type == "uncertain"
        assert v.confidence == 0.7
        assert v.error_code == "TYPE_MISMATCH"

    def test_invalid_confidence_raises(self):
        with pytest.raises(ValidationError):
            build_verdict(
                verified=True,
                evidence=[{"file": "f.ts", "line": 1, "snippet": "ok"}],
                file_hashes={"f.ts": "a" * 64},
                duration_ms=42,
                confidence=2.0,
            )

    def test_missing_required_field_raises(self):
        with pytest.raises(TypeError):
            build_verdict(
                verified=True,
                evidence=[{"file": "f.ts", "line": 1, "snippet": "ok"}],
                file_hashes={"f.ts": "a" * 64},
                # missing duration_ms
            )
