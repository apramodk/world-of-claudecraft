"""Shared state for the buildflow graph."""
from typing import TypedDict, Optional

# Ordered pipeline: (step name, shell command). Commands run from the repo root.
PIPELINE: list[tuple[str, str]] = [
    ("install", "npm install"),
    ("typecheck", "npx tsc --noEmit"),
    ("unit_tests", "npx vitest run"),
    ("build_client", "npm run build"),
    ("build_server", "npm run build:server"),
]
MAX_FIX_ATTEMPTS = 3


class BuildState(TypedDict):
    step_index: int                 # which PIPELINE entry runs next
    failed_step: Optional[str]      # name of the step that just failed
    failure_output: str             # captured stdout+stderr of the failure
    fix_attempts: dict[str, int]    # per-step retry counter
    history: list[str]              # human-readable log lines
    proposed_edits: list[dict]      # [{"path": ..., "old": ..., "new": ...}]
