---
summary: "Full reference for the CLI onboarding wizard: every step, flag, and config field"
read_when:
  - Looking up a specific wizard step or flag
  - Automating onboarding with non-interactive mode
  - Debugging wizard behavior
title: "Onboarding Wizard Reference"
sidebarTitle: "Wizard Reference"
---

# Onboarding Wizard Reference

This is the full reference for the `bitterbot onboard` CLI wizard.
For a high-level overview, see [Onboarding Wizard](/start/wizard).

## Flow details (local mode)

<Steps>
  <Step title="Existing config detection">
    - If `~/.bitterbot/bitterbot.json` exists, choose **Keep / Modify / Reset**.
    - Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset**
      (or pass `--reset`).
    - If the config is invalid or contains legacy keys, the wizard stops and asks
      you to run `bitterbot doctor` before continuing.
    - Reset uses `trash` (never `rm`) and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)
  </Step>
  <Step title="Model/Auth">
    - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    - **Anthropic OAuth (Claude Code CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.
    - **Anthropic token (paste setup-token)**: run `claude setup-token` on any machine, then paste the token (you can name it; blank = default).
    - **OpenAI Code (Codex) subscription (Codex CLI)**: if `~/.codex/auth.json` exists, the wizard can reuse it.
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.
      - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
    - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.bitterbot/.env` so launchd can read it.
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).
    - **API key**: stores the key for you.
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config is auto-written.
    - More detail: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config is auto-written.
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: no auth configured yet.
    - Pick a default model from detected options (or enter provider/model manually).
    - Wizard runs a model check and warns if the configured model is unknown or missing auth.
    - OAuth credentials live in `~/.bitterbot/credentials/oauth.json`; auth profiles live in `~/.bitterbot/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
    - More detail: [/concepts/oauth](/concepts/oauth)
    <Note>
    Headless/server tip: complete OAuth on a machine with a browser, then copy
    `~/.bitterbot/credentials/oauth.json` (or `$BITTERBOT_STATE_DIR/credentials/oauth.json`) to the
    gateway host.
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.bitterbot/workspace` (configurable).
    - Seeds the workspace files needed for the agent bootstrap ritual.
    - Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale exposure.
    - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non‑loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - DM security: default is pairing. First DM sends a code; approve via `bitterbot pairing approve <channel> <code>` or use allowlists.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux (and Windows via WSL2): systemd user unit
      - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.
  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `bitterbot health`.
    - Tip: `bitterbot status --deep` adds gateway health probes to status output (requires a reachable gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Wallet (USDC on Base)">
    - Confirms whether to enable the agent's USDC smart wallet.
    - If enabled and CDP credentials are not already present, walks through
      creating them on [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com):
      - **API Key** (Project → API Keys → Create API key): yields an ID (UUID)
        and Secret (Ed25519 base64). Secret is shown once.
      - **Wallet Secret** (Wallets → Wallet Secret → Create): separate key
        that authorizes signing. Also shown once.
    - The wizard opens each portal page for you; pick **"I already have keys"**
      to skip the browser opens and paste existing values, or **"Skip for now"**
      to defer setup (wallet stays disabled until you re-run
      `bitterbot configure --section wallet` or set the env vars yourself).
    - Persists the API Key pair to `wallet.cdpApiKeyId` /
      `wallet.cdpApiKeySecret` in `~/.bitterbot/bitterbot.json`; persists
      the Wallet Secret as `CDP_WALLET_SECRET` in `~/.bitterbot/.env`
      (mode 0600).
    - Defaults to `base-sepolia` (testnet). Switch to mainnet only after
      watching agent behavior for a while.
    - In **advanced** mode, lets you tune per-transaction, daily, and
      per-session spend caps (defaults: $25 / $50 / $50).
    - More detail: [Agent wallet](/wallet)
  </Step>
  <Step title="Finish">
    - Summary + next steps.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm build` (auto-installs UI deps).
</Note>

## Non-interactive mode

Use `--non-interactive` to automate or script onboarding:

```bash
bitterbot onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 19001 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Add `--json` for a machine‑readable summary.

<Note>
`--json` does **not** imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    bitterbot onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 19001 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    bitterbot onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 19001 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    bitterbot onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 19001 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    bitterbot onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 19001 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    bitterbot onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 19001 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    bitterbot onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 19001 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    bitterbot onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 19001 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Add agent (non-interactive)

```bash
bitterbot agents add work \
  --workspace ~/.bitterbot/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (Control UI) can render steps without re‑implementing onboarding logic.

## Signal setup (signal-cli)

The wizard can install `signal-cli` from GitHub releases:

- Downloads the appropriate release asset.
- Stores it under `~/.bitterbot/tools/signal-cli/<version>/`.
- Writes `channels.signal.cliPath` to your config.

Notes:

- JVM builds require **Java 21**.
- Native builds are used when available.
- Windows uses WSL2; signal-cli install follows the Linux flow inside WSL.

## What the wizard writes

Typical fields in `~/.bitterbot/bitterbot.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (if Minimax chosen)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`
- Channel allowlists (Slack/Discord/Matrix/Microsoft Teams) when you opt in during the prompts (names resolve to IDs when possible).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`bitterbot agents add` writes `agents.list[]` and optional `bindings`.

WhatsApp credentials go under `~/.bitterbot/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.bitterbot/agents/<agentId>/sessions/`.

CDP wallet credentials split between two places for security:

- **API Key pair** (`wallet.cdpApiKeyId`, `wallet.cdpApiKeySecret`) → `~/.bitterbot/bitterbot.json`
- **Wallet Secret** (`CDP_WALLET_SECRET`) → `~/.bitterbot/.env` (read by the gateway's dotenv loader)
- Smart wallet metadata (address, owner address) → `~/.bitterbot/wallet/wallet-data.json`

Some channels are delivered as plugins. When you pick one during onboarding, the wizard
will prompt to install it (npm or a local path) before it can be configured.

## Related docs

- Wizard overview: [Onboarding Wizard](/start/wizard)
- Config reference: [Gateway configuration](/gateway/configuration)
- Providers: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
