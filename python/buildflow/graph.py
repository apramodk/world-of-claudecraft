"""LangGraph wiring: pipeline with diagnose/fix loop."""
from langgraph.graph import StateGraph, START, END
from .state import PIPELINE, BuildState
from .steps import run_step, route_after_step
from .fixer import diagnose, apply_fix


def write_report(state: BuildState) -> BuildState:
    from . import steps
    done = state["step_index"] >= len(PIPELINE) and state["failed_step"] is None
    lines = ["# buildflow report", "", f"**Result: {'SUCCESS' if done else 'FAILED'}**", ""]
    lines += [f"- {h}" for h in state["history"]]
    (steps.REPO_ROOT / "buildflow-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return state


def build_graph():
    g = StateGraph(BuildState)
    g.add_node("run_step", run_step)
    g.add_node("diagnose", diagnose)
    g.add_node("apply_fix", apply_fix)
    g.add_node("report", write_report)
    g.add_edge(START, "run_step")
    g.add_conditional_edges("run_step", route_after_step,
                            {"run_step": "run_step", "diagnose": "diagnose", "report": "report"})
    g.add_edge("diagnose", "apply_fix")
    g.add_edge("apply_fix", "run_step")
    g.add_edge("report", END)
    return g.compile()
