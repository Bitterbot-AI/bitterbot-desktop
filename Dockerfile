# This file could not build from the initial commit until 2026-08-26: it copied
# a `ui/` dir and `patches/` that never existed, ran an undefined `pnpm
# ui:build`, and installed Bun for nothing (V1 audit blocker 4). It is verified
# by the docker-build job in CI; keep that job green when touching this file.

FROM node:22-bookworm

RUN corepack enable

WORKDIR /app

ARG BITTERBOT_DOCKER_APT_PACKAGES=""
RUN if [ -n "$BITTERBOT_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $BITTERBOT_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Manifests first so the dependency layer only rebuilds when they change.
# desktop/ and extensions/* are pnpm workspace members: without their
# package.json files, `--frozen-lockfile` fails against the workspace lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY desktop/package.json ./desktop/
# One line per extension, deliberately: `COPY --parents` needs a newer BuildKit
# than CI's classic builder (and many self-hosters' Docker) provides. If a new
# extension gains a package.json and is missed here, --frozen-lockfile fails
# and the CI docker job catches it.
COPY extensions/discord/package.json ./extensions/discord/
COPY extensions/google-antigravity-auth/package.json ./extensions/google-antigravity-auth/
COPY extensions/google-gemini-cli-auth/package.json ./extensions/google-gemini-cli-auth/
COPY extensions/signal/package.json ./extensions/signal/
COPY extensions/slack/package.json ./extensions/slack/
COPY extensions/telegram/package.json ./extensions/telegram/
COPY extensions/twitch/package.json ./extensions/twitch/
COPY extensions/whatsapp/package.json ./extensions/whatsapp/
COPY scripts ./scripts

# postinstall fetches the orchestrator binary. Point it INSIDE the image at the
# repo-relative path the resolver probes, not the default ~/.bitterbot/bin:
# HOME is /root during build but the runtime user is `node`, and compose mounts
# the host config dir over /home/node/.bitterbot, which would shadow anything
# placed there. Fetch failures are non-fatal by design (the gateway runs
# isolated without P2P), so an unpublished release does not break the build.
ENV BITTERBOT_ORCHESTRATOR_INSTALL_DIR=/app/orchestrator/target/release
RUN pnpm install --frozen-lockfile

COPY . .
# `pnpm build` includes ui:build since PLAN-39: the gateway serves the Control
# UI it stages into dist/control-ui, so the image ships the full product on one
# port with no separate UI process.
RUN pnpm build

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: run as the non-root `node` user (uid 1000).
USER node

# Start gateway server with default config. Binds to loopback (127.0.0.1) by
# default for security; the Control UI is served by the gateway at /.
#
# For container platforms requiring external health checks:
#   1. Set BITTERBOT_GATEWAY_TOKEN or BITTERBOT_GATEWAY_PASSWORD env var
#   2. Override CMD: ["node","bitterbot.mjs","gateway","--allow-unconfigured","--bind","lan"]
CMD ["node", "bitterbot.mjs", "gateway", "--allow-unconfigured"]
