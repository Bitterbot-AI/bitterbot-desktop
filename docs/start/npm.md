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

On macOS and Linux the recommended install is the
[installer one-liner](/start/install-script): it needs no Node and no
`sudo`. If you prefer npm, that works too, with any Node 18 or newer:

```bash
npm install -g bitterbot
bitterbot onboard
```

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

Every later run starts Bitterbot directly. `bitterbot onboard` starts the
gateway and opens a setup page in your browser (`--no-browser` keeps setup in
the terminal): model key, model, memory, web search, channels and P2P.
Afterwards the Control UI is at `http://127.0.0.1:19001/`.

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
`/usr/local`, which your user cannot write to, so `npm install -g` fails with
`EACCES`. Do not use `sudo` to get around it: everything would be owned by
root, the launcher would install into root's home instead of yours, and
every later update would need `sudo` again.

Pick one fix:

- **Use the installer instead.** It needs no Node and no `sudo`:
  `curl -fsSL https://github.com/Bitterbot-AI/bitterbot-desktop/releases/latest/download/install.sh | bash`
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
  Their global prefix is already yours.

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
  somewhere else.
- **Every run** starts `~/.bitterbot/app/current/bin/bitterbot` with your
  arguments. Offline with an older version already installed, the launcher
  says so and starts that one.

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
start. The launcher then keeps running whatever `current` points at.

Updating through npm works too:

```bash
npm install -g bitterbot@latest
```

The next `bitterbot` run downloads and switches to that version (the
previous one is kept for rollback). Details:
[`bitterbot update`](/cli/update#npm-package-installs).

### Coming from the 1.6.0 or 1.6.1 npm package

Those versions installed the whole app through npm (a long install with many
warnings). Updating them (`bitterbot update`, or
`npm install -g bitterbot@latest`) replaces the package with the launcher;
the update's own checks then download the release, and a gateway service
installed from the old package keeps working: the files it points at
forward to the launcher. Nothing in `~/.bitterbot` changes. To point the
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
