/** Standalone overlays predate the core-owned Compute runtime and payment gate. */
throw new Error(
  "Compute is now bundled with Bitterbot. Build the gateway and Control UI with " +
    "`pnpm build` and `pnpm --filter bitterbot-control-ui build`, then use the normal " +
    "release pipeline (`node scripts/build-release-tarball.mjs --out release-out`). " +
    "Standalone overlays cannot carry the current gateway's shared payment state. " +
    "To reproduce an older Soapbox preview, use the source revision recorded in that release.",
);
