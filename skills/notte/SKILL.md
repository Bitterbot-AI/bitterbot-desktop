---
name: notte
description: Deploy browser automations as scheduled, API-callable serverless Functions — plus stealth sessions, vault-backed login, captcha solving, and natural-language agent runs via the Notte CLI. Turns any browser flow into a deterministic Bitterbot-callable endpoint, ideal for crystallized skills + dream-engine cron schedules.
homepage: https://notte.cc
metadata:
  {
    "bitterbot":
      {
        "emoji": "🥷",
        "requires": { "bins": ["notte"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "tap": "nottelabs/notte-cli https://github.com/nottelabs/notte-cli.git",
              "formula": "notte",
              "bins": ["notte"],
              "label": "Install Notte CLI (brew)",
            },
            {
              "id": "go",
              "kind": "go",
              "module": "github.com/nottelabs/notte-cli/cmd/notte@latest",
              "bins": ["notte"],
              "label": "Install Notte CLI (go)",
            },
          ],
      },
  }
---

# Notte

Hosted browser infrastructure with a CLI that does three things the bundled `browser` tool and Firecrawl cannot:

1. **Functions** — deploy a browser automation script as a serverless, API-callable endpoint with built-in cron scheduling. The natural fit for crystallized skills and dream-engine cycles.
2. **Vault-backed login** — passwords auto-fill on matching URLs without ever entering the model's context.
3. **Stealth sessions** — residential proxies + inline captcha solving, for sites where the bundled Chromium gets locked out.

## Functions — deploy a browser flow as a callable API

Crystallized skills and dream-cycle automations both want the same thing: a stable, repeatable browser action the agent can call by name on a schedule. Notte Functions is exactly that.

```bash
# 1. Capture an agent's run as deterministic Python (or hand-write it).
notte agents workflow-code   # exports the latest agent's steps as Python
notte sessions workflow-code # or export from a CLI session

# 2. Deploy the script as a Function (one-shot — no servers, no infra).
notte functions create --file workflow.py
# → returns function_id

# 3. Run on demand, or schedule.
notte functions run                                # one-off
notte functions schedule-set --cron "0 */2 * * *"  # every 2h, matches dream cycles
notte functions runs                               # invocation history
notte functions fork                               # version forward without losing the original

# 4. Or invoke via HTTP from anywhere (skill scripts, gateway hooks, channels).
curl -X POST https://api.notte.cc/functions/{function_id}/runs/start \
  -H "Authorization: Bearer $NOTTE_API_KEY" \
  -d '{"url":"https://example.com","query":"laptop"}'
```

**Why this matters for Bitterbot:**

- A crystallized skill that ends in "open this URL and grab the data" can be backed by a Function — fast, deterministic, no LLM tokens per execution.
- Function `schedule-set` aligns directly with dream-engine cron triggers (every 2h consolidation, daily syncs, hourly monitors).
- `notte agents workflow-code` is structurally the same pattern as Bitterbot's dream engine crystallizing execution paths — the agent figures out the steps, then the deterministic Function takes over for production.
- Functions auto-inherit Notte's session capabilities: vault credentials, stealth proxies, captcha solving — without re-deploying anything.

## When to use Notte vs the bundled tools

| Need | Use |
|---|---|
| Open a tab, click around, take a snapshot | **Bundled `browser` tool** (`src/browser/`) |
| Pull a single page through a stealth fetch | **Firecrawl via `web_fetch`** (`docs/tools/firecrawl.md`) |
| **Crystallize a recurring browser flow into a callable API endpoint** | **`notte functions`** |
| **Schedule a browser flow on a cron (dream-cycle aligned)** | **`notte functions schedule-set`** |
| Run a multi-step task on an authenticated site | **`notte` session** |
| Log in without exposing the password to the LLM | **`notte` vault** |
| The bundled browser is being challenged with captcha / Cloudflare / DataDome | **`notte`** (`--solve-captchas`, `--proxy`) |
| Need a residential / geo-located IP | **`notte`** |
| Hand a browsing goal to an agent and get a structured answer | **`notte agents`** |

`notte` does not replace the bundled browser. It's the deployment + infrastructure layer for browser flows that need to outlive a single agent run.

## Setup

```bash
# Install (handled by the install metadata above).
brew tap nottelabs/notte-cli https://github.com/nottelabs/notte-cli.git && brew install notte
# or:
go install github.com/nottelabs/notte-cli/cmd/notte@latest

# Authenticate. Stores the API key in the system keyring.
notte auth login
# or: export NOTTE_API_KEY=...
```

## Quick start

```bash
notte sessions start --proxy --solve-captchas
notte page goto "https://news.ycombinator.com"
notte page observe
notte page scrape --instructions "Top 10 story titles, points, and URLs as JSON"
notte sessions stop -y
```

`observe` returns interactive element IDs (`@B3`, `@I1`, `@L9`). Use those with `click` / `fill`, or fall back to Playwright selectors (`#submit`, `button:has-text('Submit')`) — both are accepted.

## Vault-backed login (the biggest UX win over the bundled browser)

`docs/tools/browser-login.md` recommends manual login because automated logins trigger anti-bot defenses and can lock the account. Notte fixes this: store credentials in a vault and the browser auto-fills on matching URLs. The agent never sees the password.

```bash
notte vaults create --name "myservice"
notte vaults credentials add --vault-id <vault-id> \
  --url "https://myservice.com" \
  --email "user@example.com" \
  --password "..." \
  --mfa-secret "<TOTP_BASE32_SECRET>"   # optional TOTP

notte sessions start
notte page goto "https://myservice.com/login"
# Credentials auto-fill from the matching vault entry.
```

This unblocks autonomous flows during dream cycles where there's no user available to log in manually.

## Agent runtime (delegate the whole task)

For multi-step goals, hand the task to a Notte agent:

```bash
notte agents start --task "Find the cheapest non-stop SFO→CDG flight on Sep 14 and return the URL"
notte agents status
notte agents replay     # session recording / step trace
```

Agents are cheaper than authoring step-by-step CLI calls when the task has many branches.

## Stealth flags worth knowing

| Flag                   | Effect                                                |
| ---------------------- | ----------------------------------------------------- |
| `--proxy`              | Route through Notte's residential proxy pool          |
| `--proxy-country <c>`  | ISO country code (`us`, `gb`, `fr`, `de`, …)          |
| `--solve-captchas`     | Auto-solve reCAPTCHA / hCaptcha / Cloudflare turnstile |
| `--user-agent <ua>`    | Pin a specific UA string                              |
| `--cdp-url <url>`      | Bring-your-own remote browser (e.g. Lightpanda)       |
| `--headless=false`     | Required when `--cdp-url` points to Lightpanda Cloud  |

## Page actions (cheat sheet)

```bash
notte page click "@B3" | "#submit-button"
notte page fill "@I1" "hello"        # add --enter to submit
notte page check "#tos"
notte page select "#country" "France"
notte page upload "#file" --file ./report.pdf
notte page download "@L5"
notte page eval-js 'document.title'
notte page screenshot
notte page wait 500
notte page press "Enter" | "Escape" | "Tab"
notte page scroll-down [px] | scroll-up [px]
```

Navigation: `goto`, `back`, `forward`, `reload`, `new-tab`, `switch-tab`, `close-tab`.

## Structured extraction

```bash
notte page scrape --instructions "Every job posting: title, company, location, salary range" -o json
notte page scrape --instructions "Article body and author" --only-main-content
```

Note: for routine single-page extraction without auth or anti-bot needs, `web_fetch` (with Firecrawl) is the lighter path. Use `notte page scrape` when extraction lives behind login or after a multi-step navigation.

## MCP path (no install required)

Notte ships an MCP server (`notte-mcp`). It can be called through the existing `mcporter` skill without installing the Notte CLI:

```bash
NOTTE_API_KEY=... mcporter call --stdio "uv run --with notte-mcp python -m notte_mcp.server" \
  notte_scrape url=https://example.com instructions="Extract pricing tiers"
```

Use the CLI by default — the MCP path is mainly useful inside flows already orchestrating MCP calls.

## Live viewer (debugging)

```bash
notte sessions start -o json | jq -r '.viewer_url'
# or
notte sessions viewer
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `NOTTE_API_KEY` | API key (alternative to `notte auth login`) |
| `NOTTE_SESSION_ID` | Default session for `page` commands |
| `NOTTE_API_URL` | Override API endpoint |
| `NOTTE_MCP_SERVER_PROTOCOL` | `stdio` or `sse` (only for the MCP server) |

## Tips

- **Always `observe` before `click` / `fill` / `scrape`.** Element IDs come from observe output.
- **After every navigation, `observe` again** — IDs are scoped to the current DOM snapshot.
- **Stop sessions you start.** `notte sessions stop -y` skips the prompt. Idle sessions cost API budget.
- **Lightpanda + `--cdp-url` requires `--headless=false`.** Otherwise the CDP server returns 500.
- **`@B3` clicking the wrong element?** Fall back to a Playwright selector.
- **Modals blocking clicks?** `notte page press "Escape"` then `notte page wait 500`.

## Troubleshooting

| Symptom                            | Fix                                                       |
| ---------------------------------- | --------------------------------------------------------- |
| Site keeps blocking / shows captcha | Restart with `--proxy --solve-captchas`                  |
| Empty / partial scrape             | Add `notte page wait 1000` then re-`observe` before `scrape` |
| `@B3` clicks the wrong thing       | Use a Playwright selector (`button:has-text('Submit')`)  |
| Lightpanda CDP returns 500         | Add `--headless=false` to `sessions start`               |
| Agent stuck on a captcha           | Stop session, restart with `--solve-captchas`            |
| 401 / auth errors                  | Re-run `notte auth login` or set `NOTTE_API_KEY`         |
