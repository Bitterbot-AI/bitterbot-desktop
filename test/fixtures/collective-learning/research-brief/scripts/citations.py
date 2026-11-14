"""Preserve disagreement; these helpers do not certify the generated brief."""


def assemble(task, sources):
    findings = [{"metric": s["metric"], "value": s["value"], "sourceId": s["id"], "date": s["date"]} for s in sources]
    conflict = any(a["metric"] == b["metric"] and a["value"] != b["value"] for a in sources for b in sources)
    return {
        "question": task["question"], "findings": findings,
        "uncertainties": ["Current sources conflict; reconcile measurement definitions and time windows before deciding."] if conflict else ["These sources alone do not establish general applicability."],
        "recommendation": "Use a limited pilot and verify the unresolved evidence before expanding.",
        "followUp": {"owner": task["followUpOwner"], "action": "Confirm source definitions and report remaining uncertainty."},
    }
