---
summary: "How to author and register a new pre-action interceptor (PLAN-20)"
read_when:
  - Adding a new built-in interceptor
  - Extending the interceptor system
title: "Skill Author Guide — Pre-Action Interceptors"
---

# Authoring a Pre-Action Interceptor

This walks through adding a new built-in interceptor end-to-end. The high-level overview lives in [interceptors.md](interceptors.md); this is the practical reference for someone who wants to ship one.

## When you want an interceptor

You should reach for a pre-action interceptor when:

- A skill's promise is _deterministic_ (every time condition X, do Y), not advisory
- The activation condition is cheap to evaluate (a few regexes, a hormonal threshold, a tool-history check)
- The intervention is one of: rewrite params, inject context, require a prerequisite tool, or block outright
- Failing to enforce the rule costs the user something concrete: wrong answer, leaked secret, wasted tokens, missed context

You should NOT reach for an interceptor when:

- The condition needs to read external state (network, filesystem, another LLM)
- The intervention is a long-running computation
- The behavior is fundamentally probabilistic ("usually do X")
- A SKILL.md prompt is sufficient because the failure mode is rare

## Step 1 — Implement the interceptor

Built-in interceptors live under `src/agents/skills/builtin-interceptors/`. Create a new file `<name>.ts`:

```ts
import type { CandidateAction, PreActionInterceptor, StepContext } from "../interceptor.js";

export const myGuard: PreActionInterceptor = {
  id: "my-guard:default",
  skill: "my-guard",
  priority: 60,
  maxFiresPerEpisode: 4,
  tools: ["send_message", "discord_send"],

  shouldActivate(ctx: StepContext, action: CandidateAction): boolean {
    // Cheap pre-check. Return false fast for non-matching states.
    if (ctx.hormonal.cortisol < 0.7) return false;
    return true;
  },

  intervene(ctx: StepContext, action: CandidateAction) {
    return {
      type: "inject",
      contextText: `Cortisol is high (${ctx.hormonal.cortisol.toFixed(2)}). Be brief.`,
      reason: "stress-mode brevity",
    };
  },
};
```

Field reference:

| Field                | Required | Purpose                                                                                                |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `id`                 | yes      | Globally unique, `<skill>:<variant>`. Used as the registry key and in records.                         |
| `skill`              | yes      | SKILL.md name. Multiple interceptors can share a skill.                                                |
| `priority`           | no       | Higher fires first. 0–100. 80+ for safety guards, 40–70 for functionality, lower for cosmetic.         |
| `maxFiresPerEpisode` | no       | Cap per-session firings. Default unlimited. 3–8 is typical.                                            |
| `tools`              | no       | Pre-filter. Skip evaluation entirely if the candidate tool name isn't in this list.                    |
| `shouldActivate`     | yes      | Pure-ish predicate. Must be fast (≤ 3ms p95). Throwing here counts as a strike.                        |
| `intervene`          | yes      | Produces the Intervention object. Allowed to be slower; still counts against the 50ms per-step budget. |

## Step 2 — Pick an intervention type

| Type             | When to use                                                                                    | Visible to the user?                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `modify`         | You want to rewrite the action's params (e.g. hedge a confident claim before it sends).        | Implicit (the rewrite ships).                          |
| `inject`         | You want to add corrective context for the next reasoning step.                                | No direct effect on the current action.                |
| `require_prereq` | You want a different tool to run first, then the agent should re-evaluate the original action. | The agent reads a structured `INTERCEPTOR:` directive. |
| `block`          | The action must not happen until the user confirms. Pair with `userVisibleMessage`.            | The user sees the `userVisibleMessage` inline.         |
| `noop`           | You looked but had nothing to do. Don't waste a fire slot.                                     | No record persisted.                                   |

## Step 3 — Register at autoboot

Edit `src/agents/skills/builtin-interceptors/index.ts`:

```ts
import { myGuard } from "./my-guard.js";

export function registerBuiltinInterceptors(): void {
  if (registered) return;
  registered = true;
  const registry = getInterceptorRegistry();
  // ... existing registrations ...
  registry.register(myGuard, "builtin");
}
```

The autoboot runs once on the first tool call. No gateway restart sequencing required beyond rebuilding the bundle.

## Step 4 — Write the SKILL.md companion

Create `skills/my-guard/SKILL.md`:

```yaml
---
name: my-guard
description: One-line description of the user-visible behavior.
tier: executable
bitterbot:
  always: false
  interceptors:
    - id: my-guard:default
      builtin: true
      activates_on: high-cortisol send_message
      intervention: inject
---

# my-guard

Prose describing why this skill exists, what the user will see, and when it fires.

## Implementation

Built-in interceptor `my-guard:default` lives in `src/agents/skills/builtin-interceptors/my-guard.ts`.
```

The SKILL.md is documentation + marketplace metadata. The actual behavior is the compiled TS module.

## Step 5 — Write tests

Create `src/agents/skills/builtin-interceptors/my-guard.test.ts` modeled on the existing `interceptors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { myGuard } from "./my-guard.js";
import { __testing as ctxTesting } from "../interceptor-context.js";
import type { StepContext } from "../interceptor.js";

function mkCtx(over: Partial<StepContext> = {}): StepContext {
  return {
    sessionKey: "test",
    agentId: "main",
    channel: "internal",
    turnNumber: 1,
    hormonal: ctxTesting.NEUTRAL_HORMONAL,
    gccrf: ctxTesting.NEUTRAL_GCCRF,
    recentTurns: [],
    toolHistory: [],
    ...over,
  } as StepContext;
}

describe("my-guard", () => {
  it("fires when cortisol is high", () => {
    const ctx = mkCtx({ hormonal: { ...ctxTesting.NEUTRAL_HORMONAL, cortisol: 0.9 } });
    expect(myGuard.shouldActivate(ctx, { toolName: "send_message", params: {} })).toBe(true);
  });

  it("does not fire when cortisol is low", () => {
    const ctx = mkCtx();
    expect(myGuard.shouldActivate(ctx, { toolName: "send_message", params: {} })).toBe(false);
  });
});
```

Run with `pnpm exec vitest run src/agents/skills/builtin-interceptors/my-guard.test.ts`.

## Step 6 — Verify in the running gateway

1. Rebuild `dist/entry.js`: `node scripts/build-gateway-entry.mjs`
2. Restart the gateway: `pnpm start gateway`
3. Open the UI → **Active Guards** tab. Your skill should appear in the Registered list.
4. Trigger the activation condition through a real chat turn. The live feed should show the firing within ~100ms of the tool call.

## Priority recommendations

- **80–100** — safety-critical guards that should short-circuit ahead of everything else (e.g. wallet protections, group-cadence). Use sparingly.
- **60–80** — functionality enforcers (recall-before-claim style). The default range for most new interceptors.
- **40–60** — cosmetic / calibration (calibrate-claim-confidence). Composable with higher-priority modifiers.
- **0–40** — opt-in suggestions; rare.

Multiple interceptors can compose `modify` interventions sequentially in priority-desc order. Each `modify` sees the params produced by the prior interceptors in the chain.

## What to avoid

- **Async I/O in `shouldActivate`**. The predicate must complete in single-digit milliseconds.
- **Cross-session shared state**. Use the session-context tracker if you need recent history; never reach into the memory DB directly from a hot-path interceptor.
- **Throwing instead of NOOPing**. Throws count as strikes (3 → auto-disable, persistent across restarts).
- **Reading PII**. `recentTurns` previews are already redacted to 80 chars with email/credit-card scrubbing. Do not undo that.
- **Recursive interventions**. `intervene` must not call any tool. It produces an Intervention object; the runner handles dispatch.

## Related

- [interceptors.md](interceptors.md) — system overview
- [interceptors-runbook.md](interceptors-runbook.md) — operator runbook for the running system
- PLAN-20 design doc: `research/plans/PLAN-20-EXECUTABLE-SKILL-INTERCEPTORS.md`
