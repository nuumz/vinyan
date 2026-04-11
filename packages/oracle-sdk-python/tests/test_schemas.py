"""Tests for ECP schema models — round-trip serialization and validation."""

import json
import pytest
from pydantic import ValidationError

from vinyan_oracle_sdk.schemas import (
    DeliberationRequest,
    Evidence,
    HypothesisTuple,
    OracleVerdict,
    QualityScore,
    TemporalContext,
)


class TestHypothesisTuple:
    def test_basic(self):
        h = HypothesisTuple(target="src/main.ts", pattern="type-check", workspace="/project")
        assert h.target == "src/main.ts"
        assert h.context is None

    def test_with_context(self):
        h = HypothesisTuple(
            target="src/main.ts",
            pattern="symbol-exists",
            context={"symbol": "foo"},
            workspace="/project",
        )
        assert h.context == {"symbol": "foo"}

    def test_json_round_trip(self):
        h = HypothesisTuple(target="f.ts", pattern="type-check", workspace="/w")
        data = json.loads(h.model_dump_json(by_alias=True))
        assert "target" in data
        assert "workspace" in data
        restored = HypothesisTuple.model_validate(data)
        assert restored == h

    def test_camel_case_serialization(self):
        """Verify JSON uses camelCase (no change for single-word fields)."""
        h = HypothesisTuple(target="f.ts", pattern="p", workspace="/w")
        data = json.loads(h.model_dump_json(by_alias=True, exclude_none=True))
        assert set(data.keys()) == {"target", "pattern", "workspace"}


class TestEvidence:
    def test_basic(self):
        e = Evidence(file="src/main.ts", line=10, snippet="function foo()")
        assert e.content_hash is None

    def test_with_content_hash(self):
        e = Evidence(file="f.ts", line=1, snippet="x", content_hash="a" * 64)
        assert e.content_hash == "a" * 64

    def test_camel_case(self):
        e = Evidence(file="f.ts", line=1, snippet="x", content_hash="abc")
        data = json.loads(e.model_dump_json(by_alias=True))
        assert "contentHash" in data


class TestQualityScore:
    def test_defaults(self):
        q = QualityScore(architectural_compliance=0.9, efficiency=0.8, composite=0.85)
        assert q.dimensions_available == 2
        assert q.phase == "phase0"

    def test_camel_case(self):
        q = QualityScore(architectural_compliance=0.9, efficiency=0.8, composite=0.85)
        data = json.loads(q.model_dump_json(by_alias=True))
        assert "architecturalCompliance" in data
        assert "dimensionsAvailable" in data


class TestDeliberationRequest:
    def test_basic(self):
        d = DeliberationRequest(reason="need deeper analysis", suggested_budget=5000)
        assert d.suggested_budget == 5000

    def test_camel_case(self):
        d = DeliberationRequest(reason="r", suggested_budget=100)
        data = json.loads(d.model_dump_json(by_alias=True))
        assert "suggestedBudget" in data


class TestTemporalContext:
    def test_basic(self):
        t = TemporalContext(valid_from=1000, valid_until=60000, decay_model="linear")
        assert t.decay_model == "linear"

    def test_camel_case(self):
        t = TemporalContext(valid_from=1000, valid_until=2000, decay_model="step")
        data = json.loads(t.model_dump_json(by_alias=True))
        assert "validFrom" in data
        assert "validUntil" in data
        assert "decayModel" in data


class TestOracleVerdict:
    def test_minimal(self):
        v = OracleVerdict(
            verified=True,
            evidence=[Evidence(file="f.ts", line=1, snippet="ok")],
            file_hashes={"f.ts": "a" * 64},
            duration_ms=42,
        )
        assert v.type == "known"
        assert v.confidence == 1.0

    def test_full(self):
        v = OracleVerdict(
            verified=False,
            type="uncertain",
            confidence=0.7,
            evidence=[Evidence(file="f.ts", line=1, snippet="err", content_hash="b" * 64)],
            falsifiable_by=["file:f.ts:content-change"],
            file_hashes={"f.ts": "a" * 64},
            reason="type mismatch",
            error_code="TYPE_MISMATCH",
            duration_ms=150,
            quality_score=QualityScore(
                architectural_compliance=0.8, efficiency=0.7, composite=0.75
            ),
            deliberation_request=DeliberationRequest(reason="need more", suggested_budget=5000),
            temporal_context=TemporalContext(
                valid_from=1000, valid_until=60000, decay_model="linear"
            ),
        )
        assert v.error_code == "TYPE_MISMATCH"
        assert v.quality_score is not None
        assert v.deliberation_request is not None
        assert v.temporal_context is not None

    def test_confidence_bounds(self):
        with pytest.raises(ValidationError):
            OracleVerdict(
                verified=True,
                evidence=[Evidence(file="f.ts", line=1, snippet="x")],
                file_hashes={"f.ts": "a" * 64},
                duration_ms=10,
                confidence=1.5,
            )

        with pytest.raises(ValidationError):
            OracleVerdict(
                verified=True,
                evidence=[Evidence(file="f.ts", line=1, snippet="x")],
                file_hashes={"f.ts": "a" * 64},
                duration_ms=10,
                confidence=-0.1,
            )

    def test_invalid_error_code(self):
        with pytest.raises(ValidationError):
            OracleVerdict(
                verified=False,
                evidence=[Evidence(file="f.ts", line=1, snippet="x")],
                file_hashes={"f.ts": "a" * 64},
                duration_ms=10,
                error_code="NOT_A_REAL_CODE",
            )

    def test_json_round_trip_camel(self):
        """Full round-trip: Python → camelCase JSON → Python."""
        v = OracleVerdict(
            verified=True,
            evidence=[Evidence(file="f.ts", line=1, snippet="ok")],
            file_hashes={"f.ts": "a" * 64},
            duration_ms=42,
            falsifiable_by=["file:f.ts:content-change"],
        )
        json_str = v.model_dump_json(by_alias=True)
        data = json.loads(json_str)

        # Verify camelCase keys
        assert "fileHashes" in data
        assert "durationMs" in data
        assert "falsifiableBy" in data

        # Restore from camelCase
        restored = OracleVerdict.model_validate(data)
        assert restored.verified == v.verified
        assert restored.file_hashes == v.file_hashes

    def test_from_ts_json(self):
        """Parse JSON as TypeScript Oracle SDK would produce."""
        ts_json = {
            "verified": True,
            "type": "known",
            "confidence": 1.0,
            "evidence": [{"file": "src/main.ts", "line": 10, "snippet": "function foo()"}],
            "fileHashes": {"src/main.ts": "a" * 64},
            "durationMs": 42,
        }
        v = OracleVerdict.model_validate(ts_json)
        assert v.verified is True
        assert v.file_hashes == {"src/main.ts": "a" * 64}
        assert v.duration_ms == 42
