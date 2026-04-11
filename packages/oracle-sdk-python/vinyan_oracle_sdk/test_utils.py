"""Test utilities for oracle development — subprocess-based oracle testing."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from typing import Any

from .schemas import HypothesisTuple, OracleVerdict


@dataclass
class OracleTestFixture:
    """A test case for an oracle: input hypothesis + expected outcome."""

    name: str
    hypothesis: HypothesisTuple
    expected_verified: bool | None = None
    expected_type: str | None = None
    timeout_ms: float = 30_000

    def to_stdin(self) -> str:
        """Serialize hypothesis as JSON for oracle stdin."""
        return self.hypothesis.model_dump_json(by_alias=True)


@dataclass
class OracleTestResult:
    """Result of running a single oracle test fixture."""

    fixture_name: str
    passed: bool
    verdict: OracleVerdict | None = None
    error: str | None = None
    duration_ms: float = 0
    checks: list[str] = field(default_factory=list)


def run_oracle_process(
    command: list[str],
    fixtures: list[OracleTestFixture],
) -> list[OracleTestResult]:
    """Run an oracle subprocess against a list of test fixtures.

    Args:
        command: Command to spawn the oracle (e.g., ["python", "my_oracle.py"]).
        fixtures: Test cases to run.

    Returns:
        List of test results, one per fixture.
    """
    results: list[OracleTestResult] = []

    for fixture in fixtures:
        result = _run_single(command, fixture)
        results.append(result)

    return results


def _run_single(command: list[str], fixture: OracleTestFixture) -> OracleTestResult:
    """Run a single fixture against the oracle."""
    import time

    start = time.monotonic()

    try:
        proc = subprocess.run(
            command,
            input=fixture.to_stdin(),
            capture_output=True,
            text=True,
            timeout=fixture.timeout_ms / 1000,
        )
    except subprocess.TimeoutExpired:
        return OracleTestResult(
            fixture_name=fixture.name,
            passed=False,
            error=f"Oracle timed out after {fixture.timeout_ms}ms",
            duration_ms=(time.monotonic() - start) * 1000,
        )
    except Exception as e:
        return OracleTestResult(
            fixture_name=fixture.name,
            passed=False,
            error=f"Failed to run oracle: {e}",
            duration_ms=(time.monotonic() - start) * 1000,
        )

    elapsed_ms = (time.monotonic() - start) * 1000
    checks: list[str] = []

    # Check exit code
    if proc.returncode != 0:
        return OracleTestResult(
            fixture_name=fixture.name,
            passed=False,
            error=f"Oracle exited with code {proc.returncode}: {proc.stderr.strip()}",
            duration_ms=elapsed_ms,
        )

    # Parse verdict
    stdout = proc.stdout.strip()
    try:
        raw = json.loads(stdout)
    except json.JSONDecodeError as e:
        return OracleTestResult(
            fixture_name=fixture.name,
            passed=False,
            error=f"Invalid JSON output: {e}",
            duration_ms=elapsed_ms,
        )

    try:
        verdict = OracleVerdict.model_validate(raw)
    except Exception as e:
        return OracleTestResult(
            fixture_name=fixture.name,
            passed=False,
            error=f"Verdict schema validation failed: {e}",
            duration_ms=elapsed_ms,
        )

    checks.append("valid-json")
    checks.append("schema-valid")

    # Check expectations
    passed = True

    if fixture.expected_verified is not None:
        if verdict.verified == fixture.expected_verified:
            checks.append("verified-match")
        else:
            checks.append(f"verified-mismatch: expected {fixture.expected_verified}, got {verdict.verified}")
            passed = False

    if fixture.expected_type is not None:
        if verdict.type == fixture.expected_type:
            checks.append("type-match")
        else:
            checks.append(f"type-mismatch: expected {fixture.expected_type}, got {verdict.type}")
            passed = False

    return OracleTestResult(
        fixture_name=fixture.name,
        passed=passed,
        verdict=verdict,
        duration_ms=elapsed_ms,
        checks=checks,
    )
