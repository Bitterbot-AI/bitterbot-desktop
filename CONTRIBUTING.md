# Contributing to Bitterbot

Thanks for wanting to contribute! Bitterbot is an open-source project and we welcome PRs from humans and AI alike.

## Quick Start

```bash
git clone https://github.com/Bitterbot-AI/bitterbot-desktop.git && cd bitterbot-desktop
cp .env.example .env   # Add your API keys
pnpm install && pnpm build
```

**Runtime:** Node ≥ 22. **Package manager:** pnpm.

### Development Mode

```bash
# Set up the Control UI env (one-time)
cp desktop/.env.example desktop/.env
# Edit desktop/.env — paste your gateway token from ~/.bitterbot/bitterbot.json → gateway.auth.token

# Terminal 1 — Gateway with auto-reload
pnpm gateway:watch

# Terminal 2 — Control UI (Vite, hot reload)
cd desktop && pnpm dev
```

Open `http://localhost:5173` for the Control UI. It connects to the gateway on port 19001 automatically. The `VITE_GATEWAY_TOKEN` in `desktop/.env` must match the token in your gateway config (`~/.bitterbot/bitterbot.json` → `gateway.auth.token`).

## Project Structure

| Directory | What's In There |
|-----------|----------------|
| `src/agents/` | Agent runtime, tools, system prompt, identity, endocrine state |
| `src/memory/` | Memory system: dream engine, curiosity/GCCRF, crystals, hormones, governance |
| `src/gateway/` | Gateway server, RPC methods, A2A protocol, routing |
| `src/channels/` | Channel plugin system and shared logic |
| `src/whatsapp/` | WhatsApp (Baileys) |
| `src/telegram/` | Telegram (grammY) |
| `src/discord/` | Discord (discord.js) |
| `src/signal/` | Signal (signal-cli) |
| `src/slack/` | Slack (Bolt SDK) |
| `src/services/` | Wallet service, x402 verification, A2A client, Stripe onramp |
| `src/browser/` | Browser control (Playwright) |
| `src/acp/` | Agent Client Protocol server |
| `extensions/` | Bundled plugin extensions |
| `skills/` | Bundled agent skills |
| `docs/` | Documentation (Mintlify) |
| `orchestrator/` | Rust P2P sidecar (libp2p, Gossipsub, EigenTrust) |

Tests are colocated: `foo.ts` + `foo.test.ts`.

## How to Contribute

### Bug Reports

Open a [GitHub issue](https://github.com/Bitterbot-AI/bitterbot-desktop/issues) with:
- What you expected vs. what happened
- Steps to reproduce
- Output of `bitterbot status` and `bitterbot doctor`

### Feature Requests

Open an issue with the `feature` label. Describe the use case, not just the solution.

### Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add/update tests if applicable
4. Run `pnpm build` to verify the build passes
5. Open a PR with a clear description of what and why

**Keep PRs focused.** One feature or fix per PR. If you're refactoring + adding a feature, split them.

### Skills

Writing a skill is the easiest way to contribute. Skills are self-contained directories with a `SKILL.md` and optional scripts:

```
skills/my-skill/
├── SKILL.md          # Instructions for the agent
├── scripts/          # Optional helper scripts
└── assets/           # Optional reference files
```

See [Creating Skills](docs/tools/) for the full guide.

### Documentation

Docs live in `docs/` and use [Mintlify](https://mintlify.com). Edit any `.md` file and open a PR. Navigation is controlled by `docs/docs.json`.

## Code Style

- TypeScript strict mode
- No `any` unless absolutely necessary
- Use `node:` prefix for Node.js built-in imports (e.g., `import { readFile } from 'node:fs/promises'`)
- Subsystem logging via `createSubsystemLogger()`
- Extensions use the plugin SDK (`bitterbot/plugin-sdk`)

## AI/Vibe-Coded PRs

Yes, really. If you used Claude, Cursor, Copilot, or Bitterbot itself to write your PR — that's fine. We care about the output, not the process. Just make sure it builds and does what it says.

## Community

- [@Bitterbot_AI on X](https://x.com/Bitterbot_AI) — updates, questions, show off what you built
- [GitHub Discussions](https://github.com/Bitterbot-AI/bitterbot-desktop/discussions) — longer-form topics

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md) for responsible disclosure. Email **security@bitterbot.net** for sensitive issues.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
