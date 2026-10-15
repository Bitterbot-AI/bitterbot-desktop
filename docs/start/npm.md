---
summary: "Install Bitterbot from npm with `npm install -g bitterbot` (Node 22.12 or newer), what the install does, and how it updates"
read_when:
  - You already have Node 22 and want Bitterbot as a global npm package
  - You want to know what `npm install -g bitterbot` downloads and runs
  - You are updating or removing an npm install
title: "npm package"
---

# npm package

From 1.6.0, Bitterbot is published to npm as `bitterbot`. If you already run
Node 22.12 or newer, this is the shortest install:

```bash
npm install -g bitterbot
bitterbot onboard
```

`bitterbot onboard` sets up your model provider and the gateway, starts the
gateway and opens the Control UI at `http://127.0.0.1:19001/`.

Other install paths: the [installer](/start/install-script) (brings its own
Node runtime, verified and with automatic rollback on update), [Docker](/platforms/docker)
for servers, or a [source checkout](/start/getting-started#quick-setup-from-source-cli)
for development.

## Requirements

- Node 22.12 or newer (`node --version`). The install stops with a clear
  message on an older Node.
- A global npm prefix your user can write to, so neither the install nor
  `bitterbot update` needs `sudo`. Node from [nvm](https://github.com/nvm-sh/nvm),
  fnm, Volta or Homebrew already has one. With a system Node, set one once:
  `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`.
  Do not install with `sudo`: the install hook would put the P2P orchestrator
  in root's home, not yours.
- Linux, macOS, or Windows through WSL2.

## What the install does

- **Pinned dependency tree.** The package ships an `npm-shrinkwrap.json`, so
  every user gets the dependency versions CI installed and tested, including
  the security overrides (`fast-xml-parser`, `form-data`, `qs`,
  `@sinclair/typebox`, `tar`, `tough-cookie`).
- **preinstall** checks the Node version and stops on anything older than
  22.12. It does not ask for pnpm or build tools.
- **postinstall** downloads the P2P orchestrator for your platform from the
  `orchestrator-v<version>` GitHub release into `~/.bitterbot/bin`, checks the
  minisign signature of its `checksums.txt` against the key pinned in the
  package and the binary's SHA-256, and refuses a bad signature. It never
  fails the install: offline or on an unsupported platform it prints why and
  the gateway runs without P2P. Skip it with
  `BITTERBOT_SKIP_ORCHESTRATOR_DOWNLOAD=1`.
- The Control UI is inside the package (`dist/control-ui`); there is nothing
  else to build.

## Optional add-ons

Two native packages are optional peers, so npm does not download them:

| Package                 | What it enables                                                                              | Add it with                            |
| ----------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| `node-llama-cpp@3.15.1` | Local embeddings: memory search with no embeddings key (about 700 MB of builds on Linux x64) | `npm install -g node-llama-cpp@3.15.1` |
| `@napi-rs/canvas`       | Image extraction from PDFs (usually already present, as a dependency of the PDF reader)      | `npm install -g @napi-rs/canvas`       |

Without `node-llama-cpp`, memory search uses an OpenAI, Gemini or Voyage
embeddings key; with none of those it stays keyword-only. `bitterbot doctor`
says which applies to your install. The Docker image, the installer and a
source checkout include `node-llama-cpp` already.

Browser automation needs a browser: `npx playwright install chromium`, or an
installed Chrome (see [Browser](/tools/browser)).

## Updating

```bash
bitterbot update
```

On an npm install, `bitterbot update` finds the package under `npm root -g`
and runs `npm i -g bitterbot@<tag>` (`latest` on the default `stable`
channel, `beta` on the beta channel), then restarts the gateway service if
one is installed. `bitterbot update status` compares the running version
with the npm registry. If you installed into a custom prefix with
`--prefix`, run updates with the same prefix (`NPM_CONFIG_PREFIX=<prefix>`),
or simply re-run `npm install -g bitterbot@latest` yourself. Details:
[`bitterbot update`](/cli/update#npm-package-installs).

## Removing

```bash
bitterbot gateway stop          # if it is running
npm uninstall -g bitterbot
```

Your data stays in `~/.bitterbot` (config, memory, keys, the orchestrator
binary); delete that directory only if you want it gone.
