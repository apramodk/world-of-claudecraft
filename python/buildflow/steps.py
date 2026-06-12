"""Run pipeline commands and capture results."""
import subprocess
from .state import PIPELINE, MAX_FIX_ATTEMPTS, BuildState

REPO_ROOT = None  # set by __main__


def run_step(state: BuildState) -> BuildState:
    name, cmd = PIPELINE[state["step_index"]]
    print(f"[buildflow] running {name}: {cmd}")
    proc = subprocess.run(
        cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True, timeout=900,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        state["history"].append(f"PASS {name}")
        state["step_index"] += 1
        state["failed_step"] = None
        state["failure_output"] = ""
    else:
        state["history"].append(f"FAIL {name} (exit {proc.returncode})")
        state["failed_step"] = name
        state["failure_output"] = out[-12000:]  # keep the tail — errors are at the end
    return state


def route_after_step(state: BuildState) -> str:
    """Conditional edge: continue, diagnose, or finish."""
    if state["failed_step"] is not None:
        attempts = state["fix_attempts"].get(state["failed_step"], 0)
        return "diagnose" if attempts < MAX_FIX_ATTEMPTS else "report"
    if state["step_index"] >= len(PIPELINE):
        return "report"
    return "run_step"
