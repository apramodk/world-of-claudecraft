"""Run: python -m buildflow [repo_root]   (from the python/ directory)"""
import pathlib
import sys
from . import steps, fixer
from .graph import build_graph
from .state import BuildState

repo_root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2]
steps.REPO_ROOT = repo_root
fixer.REPO_ROOT = repo_root

initial: BuildState = {
    "step_index": 0, "failed_step": None, "failure_output": "",
    "fix_attempts": {}, "history": [], "proposed_edits": [],
}
build_graph().invoke(initial, config={"recursion_limit": 100})
