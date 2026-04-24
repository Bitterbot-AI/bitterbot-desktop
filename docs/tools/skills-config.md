---
summary: "Skills config schema and examples"
read_when:
  - Adding or modifying skills config
  - Adjusting bundled allowlist or install behavior
title: "Skills Config"
---

# Skills Config

All skills-related configuration lives under `skills` in `~/.bitterbot/bitterbot.json`.

```json5
{
  skills: {
    allowBundled: ["gemini"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },

      sag: { enabled: false },
    },
  },
}
```

## Fields

- `allowBundled`: optional allowlist for **bundled** skills only. When set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).
- `load.extraDirs`: additional skill directories to scan (lowest precedence).
- `load.watch`: watch skill folders and refresh the skills snapshot (default: true).
- `load.watchDebounceMs`: debounce for skill watcher events in milliseconds (default: 250).
- `install.preferBrew`: prefer brew installers when available (default: true).
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn` | `bun`, default: npm).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun not recommended for WhatsApp/Telegram).
- `entries.<skillKey>`: per-skill overrides.
- `agentskills.*`: [agentskills.io](https://agentskills.io) import bridge (see below).

Per-skill fields:

- `enabled`: set `false` to disable a skill even if it’s bundled/installed.
- `env`: environment variables injected for the agent run (only if not already set).
- `apiKey`: optional convenience for skills that declare a primary env var.

## Notes

- Keys under `entries` map to the skill name by default. If a skill defines
  `metadata.bitterbot.skillKey`, use that key instead.
- Changes to skills are picked up on the next agent turn when the watcher is enabled.

### agentskills.io import (`skills.agentskills.*`)

Opt-in bridge to the [agentskills.io](https://agentskills.io) community registry.
Disabled by default; see [Skills → Importing from agentskills.io](/tools/skills#importing-from-agentskillsio) for usage.

```json5
{
  skills: {
    agentskills: {
      enabled: true, // must be true to allow imports
      registryBaseUrl: "https://agentskills.io", // slug resolution base
      defaultTrust: "review", // "review" (quarantine) | "auto"
      transformThreshold: 0.5, // 0-1; gates marketplace promotion of derivatives
      royaltyBps: 0, // basis points reserved for upstream on paid derivatives
      maxBytes: 1048576, // reject imports larger than this (1 MB default)
    },
  },
}
```

Fields:

- `enabled` (default `false`): must be `true` before `bitterbot skills import agentskills` will run.
- `registryBaseUrl` (default `https://agentskills.io`): used to turn a slug into `<base>/skills/<slug>/SKILL.md`. Direct `https://` URLs bypass this.
- `defaultTrust` (default `review`): `review` writes to the existing P2P quarantine for explicit acceptance; `auto` installs immediately.
- `transformThreshold` (default `0.5`): when the crystallizer produces a derivative of an origin-bearing skill, `transformScore < threshold` blocks paid-marketplace publish. Keeps free-license imports free, lets transformed derivatives list.
- `royaltyBps` (default `0`): plumbing for a future upstream revenue split on derivatives. Inert today; the field persists so an upgrade doesn't require a config migration.
- `maxBytes` (default `1048576`): hard cap on fetched SKILL.md size. Anything larger is rejected before it touches disk.

### Sandboxed skills + env vars

When a session is **sandboxed**, skill processes run inside Docker. The sandbox
does **not** inherit the host `process.env`.

Use one of:

- `agents.defaults.sandbox.docker.env` (or per-agent `agents.list[].sandbox.docker.env`)
- bake the env into your custom sandbox image

Global `env` and `skills.entries.<skill>.env/apiKey` apply to **host** runs only.
