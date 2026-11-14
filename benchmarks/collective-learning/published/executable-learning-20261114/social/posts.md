# Social drafts

## LinkedIn

Can an AI agent turn a useful lesson into something it can actually reuse?

Our latest Bitterbot pilot offers an encouraging, concrete result.

We repaired a reusable DOCX helper, packaged its instructions and code together, verified the complete package, and transferred it unchanged to an isolated recipient. Then we compared ordinary agent runs with and without that learned helper on fresh document tasks.

Across 24 task attempts:

- Recorded model cost fell 59%: $5.41 → $2.20.
- Median task time fell from 109 seconds to 37 seconds across 11 fully checked pairs.
- The helper completed all 12 tasks. The baseline had 10 passes, one verified failure and one interruption.
- Every helper run read the instructions and executed the saved procedure.

The interesting part is the mechanism: a lesson became executable, verifiable and reusable. Another isolated agent environment could benefit without repeating the repair.

This was a small, same-machine pilot across three DOCX document genres—not proof of general self-improvement. Earlier tests did not establish a collective-learning advantage, and the original endpoint remains incomplete because of the interrupted baseline run. We are publishing the failures, costs, methodology and replayable artifacts alongside the gains.

Next: delayed retention, independent nodes, more task families, and a direct test of whether pooled evidence improves on package exchange alone.

Evidence: https://github.com/Bitterbot-AI/bitterbot-desktop/tree/main/benchmarks/collective-learning/published/executable-learning-20261114

#AIAgents #OpenSource #AgentLearning

## Twitter / X

Bitterbot's executable-learning pilot: 59% lower model cost, 109s → 37s median task time. Learned helper: 12 passes. Baseline: 10 passes, 1 failure, 1 interruption. Small same-machine DOCX study; broader gains unproven. Data + methodology in our GitHub. ↓

Suggested reply with the evidence link:

https://github.com/Bitterbot-AI/bitterbot-desktop/tree/main/benchmarks/collective-learning/published/executable-learning-20261114

Attach `infographic.png` to either post. Drafts only; publication has not been requested. Timing comparison uses 11 fully checked pairs; the cost comparison includes all 24 attempts. The image was generated with Codex's built-in image-generation tool; its prompt is preserved in `infographic-prompt.txt`.
