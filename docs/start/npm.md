---
summary: "Install Bitterbot from npm with `npm install -g bitterbot`: a small launcher that downloads the signed release on first run. Fixing EACCES without sudo, updating, and removing it"
read_when:
  - You want Bitterbot as a global npm package
  - You want to know what `npm install -g bitterbot` downloads and runs
  - npm failed with EACCES, or you installed with sudo before
  - You are updating or removing an npm install
title: "npm package"
---

# npm package

On macOS and Linux the recommended install is the one-command
[installer](/start/install-script): it needs no Node and no `sudo`, and it
takes you straight into setup:

```bash
curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash
```

Use npm instead only if you already manage Node with a version manager
(nvm, fnm, Volta) or Homebrew, so that `npm install -g` works for your user
without `sudo`. Then, with Node 18 or newer:

```bash
npm install -g bitterbot && bitterbot onboard
```

With Node from nodejs.org or from your distribution's `apt` packages, that
command fails with `EACCES` (see below); the fix is the installer above,
not `sudo`.

Since 1.6.2 the npm package is a small launcher. It has no dependencies and
no install scripts, so `npm install -g bitterbot` finishes in seconds and
prints no warnings. The first time you run `bitterbot`, the launcher
downloads the same signed release the installer uses (about 410 MB, with its
own Node runtime), verifies it, and starts it:

```text
Bitterbot 1.6.2: first run, downloading the signed release (410 MB)...
  [########################] 100%  410 MB / 410 MB
Verified and installed to ~/.bitterbot/app/1.6.2.
```

On a machine that is not set up yet, plain `bitterbot` (no arguments, in a
terminal) starts setup: it prints "Bitterbot isn't set up yet. Starting
setup..." and runs `bitterbot onboard`. Once setup is done, plain `bitterbot`
prints the command list as before.

`bitterbot onboard` starts the gateway and opens a setup page in your browser
(`--no-browser` keeps setup in the terminal): model key, model, memory, web
search, channels and P2P. Afterwards the Control UI is at
`http://127.0.0.1:19001/`.

Already running Bitterbot from a git clone or the installer? `bitterbot
onboard` notices the older gateway on the port and offers to switch it to
this install (`bitterbot gateway switch`, the same handoff the
[installer](/start/install-script#upgrading-from-a-git-clone-or-an-older-version)
does: snapshot, stop, point the service here, roll back if the new one does
not start). Your config, memory and keys in `~/.bitterbot` are shared and stay
as they are.

Other install paths: [Docker](/platforms/docker) for servers, or a
[source checkout](/start/getting-started#quick-setup-from-source-cli) for
development.

## Requirements

- Node 18 or newer, only to run the launcher. Bitterbot itself runs on the
  Node runtime inside the release.
- macOS (Apple silicon or Intel) or Linux x64/arm64 with glibc 2.28 or newer.
  On Windows, install inside WSL2 (see [Windows](/platforms/windows)); on
  Alpine and other musl systems, use [Docker](/platforms/docker). On an
  unsupported machine the launcher says so and exits before downloading
  anything.
- A global npm prefix your user can write to. Never install with `sudo`; see
  the next section if npm says `EACCES`.

## EACCES: permission denied

With Node from the nodejs.org installer, npm's global prefix is
`/usr/local`; with Debian's or Ubuntu's `nodejs` and `npm` packages it is
`/usr` (the error mentions `/usr/share/nodejs/...`). Your user cannot write
to either, so `npm install -g` fails with `EACCES`. The error happens inside
npm before Bitterbot runs at all, so nothing in the package can prevent it.
Do not use `sudo` to get around it: everything would be owned by root, the
launcher would install into root's home instead of yours, `npx` would break
too (npm's cache becomes root-owned), and every later update would need
`sudo` again.

The simplest fix is to stop using npm for this. The installer needs no Node
and no `sudo`, and runs setup for you:

```bash
curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash
```

If you want to stay on npm, pick one:

- **Give npm a prefix in your home directory** (zsh, the macOS default
  shell):

  ```bash
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
  source ~/.zshrc
  npm install -g bitterbot
  ```

  For bash, use `~/.bashrc` (Linux) or `~/.bash_profile` (macOS) instead of
  `~/.zshrc`.

- **Install Node with a version manager or Homebrew**
  ([nvm](https://github.com/nvm-sh/nvm), fnm, Volta, or `brew install node`).
  Their global prefix is already yours. This also replaces the old Node that
  `apt` ships on Ubuntu 22.04 and earlier (Node 12 or older), which the
  launcher cannot run on.

### Moving from a sudo install

If you installed an earlier version with `sudo`, remove that copy and give
npm's cache back to your user, then install again without `sudo`:

```bash
sudo npm uninstall -g bitterbot
sudo chown -R "$(whoami)" ~/.npm
npm install -g bitterbot
```

If `bitterbot` still runs the old copy, open a new terminal (or run
`hash -r`) and check `which bitterbot`.

## What the install does

- **`npm install -g bitterbot`** installs the launcher: one bundled
  JavaScript file, two small compatibility files, the README and the
  license. No dependencies, no install scripts, nothing downloaded besides
  the package.
- **The first run** downloads `checksums.txt` and its minisign signature for
  that exact version from the GitHub release, checks the signature against
  the release key built into the launcher (the same key the installer pins),
  requires the signed comment to name that exact release, then downloads
  your platform's tarball and checks its SHA-256. Any failure stops the
  install; there is no unsigned fallback. Then it unpacks the release to
  `~/.bitterbot/app/<version>` and points `~/.bitterbot/app/current` at it,
  the same layout the installer uses. Set `BITTERBOT_APP_DIR` to install
  somewhere else; a variable set in your shell is not seen by a background
  gateway service, so set it where the service can see it too, or keep the
  default.
- **Every run** starts `~/.bitterbot/app/current/bin/bitterbot` with your
  arguments, whatever version is installed there. The launcher never
  replaces an installed version; upgrades and rollbacks are the job of
  `bitterbot update` (below).
- **No sudo.** The launcher refuses to run as root, and refuses an app
  directory that belongs to another user (left behind by an earlier
  `sudo` run), with the command that fixes it. Set `BITTERBOT_ALLOW_ROOT=1`
  only where root is intended (a container).
- **Proxies.** Downloads honour `HTTPS_PROXY` (or `HTTP_PROXY`) and
  `NO_PROXY`, like `bitterbot update`.
- The launcher starts the app as a release install and clears any
  `BITTERBOT_INSTALL_KIND` from your environment: with the launcher you
  never need that override.

The release includes the P2P orchestrator and the local embeddings runtime
(`node-llama-cpp`), so there are no add-ons to install. Browser automation
needs a browser: an installed Chrome, Brave or Edge, or on Linux Playwright's
Chromium (see [Browser](/tools/browser)).

## Updating

```bash
bitterbot update
```

The app the launcher started is a release install, so `bitterbot update`
updates it in place, the same way as for the installer: verified, with a
snapshot of your data and automatic rollback if the new version does not
start. The launcher then keeps running whatever `current` points at, so a
`bitterbot update --rollback` stays rolled back.

`npm install -g bitterbot@latest` updates only the launcher. It does not
swap the app under you: when the launcher is newer than the installed app,
`bitterbot` prints one line at the terminal,

```text
Bitterbot 1.6.3 is available (you have 1.6.2). Run `bitterbot update` to upgrade safely.
```

and the upgrade itself is `bitterbot update`. Details:
[`bitterbot update`](/cli/update#npm-package-installs).

### Coming from the 1.6.0 or 1.6.1 npm package

Those versions installed the whole app through npm (a long install with many
warnings). Updating them (`bitterbot update`, or
`npm install -g bitterbot@latest`) replaces the package with the launcher.
The release itself (about 410 MB) is downloaded during the update's
shell-completion step, with progress shown on your terminal, or otherwise
on the next `bitterbot` run. A gateway service installed from the old
package keeps working: the files it points at forward to the launcher.
Nothing in `~/.bitterbot` changes.

The old version's update may end with `Doctor failed: ...
ERR_MODULE_NOT_FOUND`. That is harmless: the old process tried to load
files npm had just replaced. Run `bitterbot doctor` again. To point the
service at the release directly, run `bitterbot gateway install --force`
once.

## Removing

```bash
bitterbot gateway stop          # if it is running
bitterbot gateway uninstall     # if you installed the background service
npm uninstall -g bitterbot
rm -rf ~/.bitterbot/app         # the downloaded releases
```

Your data stays in `~/.bitterbot` (config, memory, keys); delete that
directory only if you want it gone.
