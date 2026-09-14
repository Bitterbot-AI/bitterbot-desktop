# Embedded Wallets setup (PLAN-49 Phase 0.5, Path B)

Per-user, non-custodial wallets so a new user gets a wallet by signing in with
email, with no CDP secrets to paste. The user owns and can export the key (it lives
in Coinbase's TEE); the agent signs autonomously within a time-bound delegation the
user grants, bounded by the usual spend caps and grants.

This page is the one-time setup only you can do (it needs your Coinbase login). The
code reads what you configure here; once the Project ID is set, the Control UI shows
a "Sign in to create your wallet" flow instead of the paste-three-secrets step.

## Prerequisites

- A Coinbase Developer Platform (CDP) account and project (the same account the
  gateway already uses).
- The gateway's existing CDP API credentials — `CDP_API_KEY_ID` and
  `CDP_API_KEY_SECRET`. Embedded-wallet delegated signing reuses these; you do NOT
  need a new API key, only the Project ID below.

## Steps

1. In the CDP Portal, open (or create) your project and enable Embedded Wallets, then
   copy the **Project ID**. It is public — it ships in the Control UI and is gated by
   the domain allowlist, not kept secret.
2. Add the Control UI origins to the project's **allowed domains** (Path B: the
   gateway serves the UI at a fixed localhost origin). Add all three:
   - `http://localhost:19001`
   - `http://127.0.0.1:19001` (a browser treats this as a different origin)
   - `http://localhost:5173` (only if you use the Vite dev server)
3. Point the wallet config at embedded provisioning:

   ```jsonc
   {
     "tools": {
       "wallet": {
         "enabled": true,
         "provisioning": "embedded",
         "embedded": { "projectId": "YOUR_CDP_PROJECT_ID" },
       },
     },
   }
   ```

4. Confirm `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set for the gateway (they
   already are if the current wallet works). Restart the gateway.

## What each piece is for

- **Project ID** (public, config): initializes the Embedded Wallet SDK in the Control
  UI so the user can sign in (email OTP) and a non-custodial wallet is created.
- **Allowed origins** (CDP Portal): CDP only serves the SDK to pages on these origins,
  which is what makes localhost workable here.
- **`CDP_API_KEY_ID/SECRET`** (gateway env): let the gateway verify the user's session
  (`validateAccessToken`) and sign transactions under the time-bound delegation while
  the user is offline — the autonomous-agent path.

## Fallback and safety

- If `provisioning` is not `"embedded"`, or `embedded.projectId` is unset, the wallet
  falls back to the existing self-host CDP Server Wallet path with no behavior change.
- Path B (localhost origins) is the single-machine start. CDP recommends against
  localhost for production because a rogue local app could present the same origin;
  the gateway only serves the real UI to an authenticated client, which mitigates
  this, but a hosted https Control UI (Path C) removes the caveat entirely and is the
  path for multi-user / LAN / remote access.

## Status

This commit wires the config, the provisioning-mode resolver, and the gateway
reporting the mode to the Control UI. The live pieces — the Control UI sign-in
surface and the gateway's delegated-signer provider — land next, against the project
you set up here.
