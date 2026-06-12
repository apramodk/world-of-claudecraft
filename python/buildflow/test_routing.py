from buildflow.state import BuildState, PIPELINE
from buildflow.steps import route_after_step


def make_state(**kw) -> BuildState:
    base: BuildState = {
        "step_index": 0, "failed_step": None, "failure_output": "",
        "fix_attempts": {}, "history": [], "proposed_edits": [],
    }
    base.update(kw)  # type: ignore[typeddict-item]
    return base


def test_success_routes_to_next_step():
    assert route_after_step(make_state(step_index=1)) == "run_step"


def test_all_steps_done_routes_to_report():
    assert route_after_step(make_state(step_index=len(PIPELINE))) == "report"


def test_failure_routes_to_diagnose():
    assert route_after_step(make_state(failed_step="unit_tests")) == "diagnose"


def test_failure_after_max_attempts_routes_to_report():
    s = make_state(failed_step="unit_tests", fix_attempts={"unit_tests": 3})
    assert route_after_step(s) == "report"
