# Bitterbot on Fly.io (PLAN-53 F1): the published image plus an entrypoint
# that makes the root-owned Fly volume writable by the `node` user.
ARG BITTERBOT_IMAGE=ghcr.io/bitterbot-ai/bitterbot-desktop:latest
FROM ${BITTERBOT_IMAGE}
USER root
COPY entrypoint.sh /usr/local/bin/bitterbot-fly-entrypoint
RUN chmod +x /usr/local/bin/bitterbot-fly-entrypoint
ENV HOME=/home/node NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/bitterbot-fly-entrypoint"]
# --allow-unconfigured: a fresh volume has no config yet; setup happens in the browser.
CMD ["node", "bitterbot.mjs", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "19001"]
