---
summary: "Teach a browser workflow by demonstration, then review and save a local skill"
read_when:
  - Turning a repeated browser task into a reusable skill
  - Reviewing what a browser demonstration records
title: "Teach a browser workflow"
---

# Teach a browser workflow

The Control UI's live-browser pane can turn a human demonstration into a
parameterized `SKILL.md`. The draft uses semantic controls and fresh browser
snapshots so the agent can find the current controls on its next run.

## Record and save

1. Open the live-browser pane while Bitterbot's browser is running. Choose
   **Take over** so this window controls the browser.
2. Open **Teach this workflow**. Enter a workflow name, your goal and the visible
   result that would demonstrate success. Choose **Record demonstration**.
3. Perform the workflow in the live-browser pane. Only interactions sent through
   this pane are captured; actions in a separate Chrome window are not captured.
4. Choose **Stop and review**. Name each input, such as `supplier` and `month`,
   and describe when the skill should and should not be used.
5. Choose **Check skill draft**. Review the generated instructions, destinations,
   parameters and manual handoff steps. Check the acknowledgement and choose
   **Save local skill**. Editing any field requires checking and reviewing again.
6. Hand browser control back to the agent. Ask it to use the saved skill with new
   inputs, for example: “Use taught-find-invoice for Acme and October.” Check the
   visible result on this first agent run.

The saved skill is available in **Skills** and through normal skill discovery.
Saving does not execute the workflow or create a scheduled task.

## Captured information

The recorder keeps the owner's goal and expected outcome, cleaned page URLs,
control roles and labels, and semantic actions such as click, type and scroll.
It does not store typed values, character counts, screenshots, clipboard contents,
raw keys or coordinates. Typing becomes a named input placeholder.

URLs lose credentials, query strings, fragments and obvious private path
segments. Labels receive basic redaction. Labels and remaining URL paths can
still contain private information: review them before saving. These records
stay on the gateway machine; running a saved skill later exposes its instructions
to the agent's configured model like any other skill.

Password and other recognized sensitive fields become browser handoffs.
Unsupported controls, including native select menus, file pickers, rich-text
editors and shortcuts, also become handoffs. No credential value is inferred or
embedded. If capture fails, the incomplete recording cannot become a skill.

## Review and skill checks

Checking uses Bitterbot's existing skill schema, injection scan, description
contract and live-skill overlap checks. A failed draft cannot be activated.
Activation rechecks the gate and requires approval of the exact checked content.
A demonstration cannot replace an existing live skill or another source's
staged candidate.

These are static checks, not a task-success evaluation. The skill's provenance
explicitly says `human_demonstration` and `owner_demonstrated_not_task_validated`.
The workflow does not synthesize successful agent traces, bypass the evolution
validation gate, register a canary, grant new tools, or publish to the P2P network.
Normal browser policy and action approvals still apply when the agent uses it.

## Limits and cleanup

- Recording requires an `operator.admin` connection controlling a supported
  live-browser session. The existing live-view restrictions, including no paired
  node streaming, still apply.
- Recording stops after ten minutes, 300 semantic steps, loss of browser control
  or loss of the live-view lease. Interrupted recordings can be reviewed after
  reconnecting, but check that their steps cover the whole workflow.
- Up to 50 recordings are kept under `browser-teaching` in the gateway's state
  directory. Files are created with owner-only permissions where supported.
- **Delete recording** removes the source record and its own unsaved staged
  draft. It does not remove a saved skill; manage that separately in **Skills**.
- Checked names and parameters survive reopening the draft. Unchecked edits do
  not. Delete an unsaved staged recording if you need to start over with a new
  skill name.

## Developer verification

Unit, gateway and UI tests cover storage, parameterization, authorization,
review invalidation and activation. An opt-in Chromium test exercises actual CDP
input, semantic capture, privacy, installation and reuse after input/layout
changes. It tests the recorded recipe, not autonomous model performance:

```bash
pnpm exec playwright install chromium --only-shell
BITTERBOT_TEACHING_BROWSER_TEST=1 pnpm exec vitest run \
  --config vitest.e2e.config.ts src/browser/teaching.e2e.test.ts
```

Set `BITTERBOT_TEACHING_CHROME_PATH` to use an existing compatible Chromium
executable instead of Playwright's default.
