"""Diagnose a failed build step with Claude and apply proposed edits."""
import json
import pathlib
from anthropic import Anthropic
from .state import BuildState

client = Anthropic()  # reads ANTHROPIC_API_KEY
REPO_ROOT: pathlib.Path = None  # set by __main__

EDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "diagnosis": {"type": "string"},
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "repo-relative file path"},
                    "old": {"type": "string", "description": "exact text to replace"},
                    "new": {"type": "string", "description": "replacement text"},
                },
                "required": ["path", "old", "new"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["diagnosis", "edits"],
    "additionalProperties": False,
}


def diagnose(state: BuildState) -> BuildState:
    step = state["failed_step"]
    state["fix_attempts"][step] = state["fix_attempts"].get(step, 0) + 1
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": EDIT_SCHEMA}},
        system=(
            "You are a build doctor for a TypeScript game project (Vite client, "
            "esbuild-bundled Node server, vitest tests). Given a failed build step's "
            "output, propose minimal exact-string file edits to fix it. If the failure "
            "is environmental (missing tool, network), return an empty edits list and "
            "say so in the diagnosis."
        ),
        messages=[{
            "role": "user",
            "content": f"Step `{step}` failed. Output (tail):\n\n{state['failure_output']}",
        }],
    )
    if response.stop_reason == "refusal":
        state["history"].append(f"diagnose {step}: refused")
        state["proposed_edits"] = []
        return state
    payload = json.loads(response.content[-1].text)
    state["history"].append(
        f"diagnose {step} (attempt {state['fix_attempts'][step]}): {payload['diagnosis'][:200]}"
    )
    state["proposed_edits"] = payload["edits"]
    return state


def apply_fix(state: BuildState) -> BuildState:
    applied = 0
    root = REPO_ROOT.resolve()
    for edit in state["proposed_edits"]:
        target = (root / edit["path"]).resolve()
        if root not in target.parents and target != root:
            state["history"].append(f"SKIP edit outside repo: {edit['path']}")
            continue
        try:
            text = target.read_text(encoding="utf-8")
        except FileNotFoundError:
            state["history"].append(f"SKIP missing file: {edit['path']}")
            continue
        if edit["old"] not in text:
            state["history"].append(f"SKIP no match in {edit['path']}")
            continue
        target.write_text(text.replace(edit["old"], edit["new"], 1), encoding="utf-8")
        applied += 1
        state["history"].append(f"EDIT {edit['path']}")
    state["history"].append(
        f"applied {applied}/{len(state['proposed_edits'])} edits, retrying {state['failed_step']}"
    )
    state["proposed_edits"] = []
    # leave step_index pointing at the failed step so run_step retries it
    state["failed_step"] = None
    state["failure_output"] = ""
    return state
