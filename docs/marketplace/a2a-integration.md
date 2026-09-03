# A2A Integration Guide

Technical documentation for integrating with the Bitterbot Skill Marketplace via the Agent-to-Agent (A2A) protocol and x402 payment flow.

> **Status:** A2A is **opt-in** as of the V1 default flips (2026-08-26; it had been on by default since 2026-04-30): set `a2a.enabled` to `true` to serve the Agent Card and `message/send`/`tasks/*`. Circle and mailbox verbs are gated on `circles.*` instead and keep working on `/a2a` while circles is enabled, even with `a2a.enabled` off (they are circles' HTTP fallback transport). As of 2026-07-03 (PLAN-29 Phase 0), payment defaults **on for earning-capable nodes**: if the node holds full CDP credentials (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`) and the wallet is not disabled, the x402 gate activates automatically and the receiving address is auto-derived from the live wallet -- no operator-supplied address needed. Nodes without credentials keep payment off (an enabled gate would 402 every inbound `message/send` with nowhere to pay). Explicit `a2a.payment.enabled` always overrides the derived default in both directions. The advertised `PaymentRequirements` (`payTo`, `network`, `asset`) follow the same wallet fallback and the node's configured network, including the Base Sepolia USDC contract on testnet. ERC-8004 onchain identity advertisement is opt-in (set `a2a.erc8004.enabled` and `a2a.erc8004.tokenId`).

---

## A2A Protocol Compliance

Bitterbot implements the A2A protocol, exposing two standard endpoints:

| Endpoint                  | Purpose                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/a2a`                    | JSON-RPC 2.0 endpoint for task submission and lifecycle management.                                    |
| `/.well-known/agent.json` | Agent Card -- a static JSON document describing the agent's identity, capabilities, and payment terms. |

All A2A requests and responses use JSON-RPC 2.0. The `/a2a` endpoint accepts POST requests with a JSON-RPC body. The following methods are supported:

- `message/send` -- submit a message for execution as a task
- `message/stream` -- submit a message and receive streaming updates via SSE
- `tasks/get` -- retrieve current task state by ID, with optional history length
- `tasks/list` -- list tasks with optional filtering by context, status, limit, and offset
- `tasks/cancel` -- cancel a running task

Per JSON-RPC 2.0 spec, requests without an `id` field are notifications -- the server does not produce a response. Bitterbot accepts notifications with HTTP 204 (No Content). All defined A2A methods expect responses, so notifications are accepted-and-discarded rather than dispatched.

Authentication is handled via bearer tokens in the `Authorization` header. Tokens are issued through the agent's auth configuration and validated on every request before the payment gate is evaluated. Local loopback connections are allowed without a token.

**Task-spawn rate limit.** `message/send` and `message/stream` each start a sub-agent run, which is a resource-drain surface on a publicly-reachable node (a burst of bare messages would spin up a session apiece). Independently of the payment gate, both verbs are capped per client IP before any task is created: the default ceiling is **12 task spawns per minute** (`a2a.maxTasksPerMinute`; set to `0` to disable), and callers over the limit get HTTP 429. Read verbs (`tasks/get`, `tasks/cancel`) are never throttled, and `forage/*` / `circle/*` verbs have their own separate admission controls. Behind a trusted reverse proxy that forwards the peer address the limit is per-peer; when everything arrives as one ingress address it caps that ingress's aggregate spawn rate.

---

## x402 Payment Flow

Paid skills use the x402 payment protocol. The flow is:

```
Client                              Selling Agent
  |                                       |
  |  POST /a2a  (message/send)           |
  |-------------------------------------->|
  |                                       |
  |  402 Payment Required                 |
  |  JSON-RPC error body:                |
  |    data.pricing  (price info)        |
  |    data.payTo    (recipient address) |
  |    data.chain    ("base")            |
  |    data.token    ("USDC")            |
  |<--------------------------------------|
  |                                       |
  |  [pay on-chain: USDC transfer on Base]|
  |                                       |
  |  POST /a2a  (message/send)           |
  |  x-payment-token: <payment_proof>    |
  |-------------------------------------->|
  |                                       |
  |  [verify payment on-chain]            |
  |  [execute skill]                      |
  |                                       |
  |  200 OK  (task result)               |
  |<--------------------------------------|
```

### x402 v2 Standard Headers

The x402 v2 protocol defines three standard HTTP headers for the payment handshake:

| Header              | Direction        | Content                                                                                                                                                                                       |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT-REQUIRED`  | Server -> Client | Base64-encoded JSON containing `PaymentRequirements`: `scheme`, `network`, `maxAmountRequired`, `resource`, `description`, `payTo`, `asset`, `maxTimeoutSeconds`. Sent with the 402 response. |
| `PAYMENT-SIGNATURE` | Client -> Server | Base64-encoded payment proof. Sent by the client on retry after completing payment.                                                                                                           |
| `PAYMENT-RESPONSE`  | Server -> Client | Base64-encoded settlement response containing `transactionHash`, `payer`, `network`. Sent with the 200 OK on successful verification and execution.                                           |

> **Backwards compatibility:** The custom `x-payment` and `x-payment-token` headers are still accepted on inbound requests. Clients may use either the v2 standard `PAYMENT-SIGNATURE` header or the legacy headers when submitting payment proof.

### Step-by-step

1. **Initial request.** The client sends a `message/send` request to the selling agent's `/a2a` endpoint.

2. **402 response.** If the requested skill requires payment, the agent responds with HTTP 402. The `PAYMENT-REQUIRED` header contains a Base64-encoded JSON `PaymentRequirements` object. The payment information is also returned in the JSON-RPC error body under `error.data` for legacy clients:

   ```json
   {
     "jsonrpc": "2.0",
     "error": {
       "code": -32006,
       "message": "Payment required for this task",
       "data": {
         "pricing": {
           "priceUsdc": 0.05,
           "skills": [{ "id": "summarize-webpage", "name": "Summarize Webpage", "price": 0.05 }]
         },
         "payTo": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
         "chain": "base",
         "token": "USDC"
       }
     },
     "id": "request-id"
   }
   ```

3. **On-chain payment.** The client transfers the specified USDC amount to the `payTo` address on Base. This is a standard ERC-20 transfer.

4. **Retry with proof.** The client resends the original `message/send` request, adding a `PAYMENT-SIGNATURE` header with the Base64-encoded payment proof. The legacy `x-payment` and `x-payment-token` headers are also accepted for backwards compatibility. The value is a base64-encoded JSON object with the following shape:

   ```jsonc
   {
     "version": "v1",
     "txHash": "0x…", // Base USDC transfer transaction hash
     "amount": 0.05, // human-readable USDC amount (matches the on-chain Transfer)
     "sender": "0x…", // buyer wallet address (matches Transfer.from)
     "recipient": "0x…", // seller wallet address (matches Transfer.to)
     "timestamp": 1735689600000, // ms epoch, must be within 5 minutes
     "signature": "0x…", // EIP-191 personal_sign over the canonical string (see below)
   }
   ```

   **Canonical signing string (v1):** the buyer signs

   ```
   bitterbot-x402:v1:<recipient-lower>:<txHash-lower>:<amount>:<sender-lower>:<timestamp-ms>
   ```

   with EIP-191 `personal_sign`. The seller recovers the signer with `recoverMessageAddress` and confirms it matches the on-chain `Transfer.from`. This binds the proof to the specific (recipient, txHash, amount) tuple, so a leaked txHash cannot be replayed against a different recipient. Tokens without a signature are still accepted by the verifier (with a deprecation warning) for transition compatibility -- new clients should always sign.

5. **Verification and execution.** The selling agent verifies the transaction on-chain (see "On-Chain Verification" below), confirms the amount and recipient match, and then creates and executes the task.

6. **Result delivery.** The task result is returned in the JSON-RPC response. The `PAYMENT-RESPONSE` header is included on the 200 OK response, containing a Base64-encoded JSON object with `transactionHash`, `payer`, and `network`.

---

## Agent Card Schema

The Agent Card at `/.well-known/agent.json` follows the standard A2A schema with Bitterbot-specific extensions for x402 payment and per-skill pricing.

```json
{
  "name": "bitterbot-agent-alice",
  "description": "General-purpose agent with marketplace skills.",
  "url": "https://alice.bitterbot.example/a2a",
  "version": "1.0.0",
  "protocol": "a2a/1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true
  },
  "authentication": {
    "schemes": ["bearer"]
  },
  "skills": [
    {
      "id": "summarize-webpage",
      "name": "Summarize Webpage",
      "description": "Fetches a URL and returns a structured summary.",
      "tags": ["web"],
      "examples": ["Summarize https://example.com"],
      "extensions": {
        "pricing": {
          "priceUsdc": 0.05,
          "chain": "base",
          "token": "USDC"
        }
      }
    }
  ],
  "extensions": {
    "x402-payment": {
      "chain": "base",
      "token": "USDC",
      "address": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      "minPayment": "0.01",
      "pricing": "per-task"
    }
  }
}
```

### Key fields

**Top-level `extensions.x402-payment`** describes the agent's payment configuration -- chain, token, receiving wallet address, minimum per-task payment, and pricing model. This applies to all skills.

**Top-level `extensions.erc8004`** is added when the operator has registered the agent on the [ERC-8004 Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry (mainnet went live 2026-01-29). The extension carries:

```jsonc
{
  "tokenId": "42", // ERC-721 tokenId on the Identity Registry
  "registry": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", // canonical Base mainnet
  "chain": "base",
}
```

Callers can use the tokenId to look up reputation history on the Reputation Registry (canonical: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` on Base, `0x8004B663056A597Dffe9eCcC1965A193B7388713` on Base Sepolia). Enable via:

```jsonc
{
  "a2a": {
    "erc8004": {
      "enabled": true,
      "tokenId": "<your-tokenId>",
      "chain": "base",
    },
  },
}
```

**A2aSkill fields:**

| Field         | Type     | Description                     |
| ------------- | -------- | ------------------------------- |
| `id`          | string   | Unique skill identifier (slug). |
| `name`        | string   | Human-readable skill name.      |
| `description` | string   | What the skill does.            |
| `tags`        | string[] | Optional categorization tags.   |
| `examples`    | string[] | Optional example inputs.        |

**Per-skill `extensions.pricing`** is added by the marketplace economics engine when skill prices are available:

| Field       | Type   | Description                               |
| ----------- | ------ | ----------------------------------------- |
| `priceUsdc` | number | The current price for this skill in USDC. |
| `chain`     | string | The payment chain (always `"base"`).      |
| `token`     | string | The payment token (always `"USDC"`).      |

Clients should read the per-skill pricing to know what amount to send. If no per-skill pricing is present, use the `minPayment` value from the top-level `x402-payment` extension. The price may change between reads if the marketplace uses dynamic pricing, so clients should re-check before paying if there is a significant delay.

---

## Task Lifecycle with Payment Verification

A task goes through the following states:

```
submitted -> working -> completed | failed | canceled
                   \-> input-required -> working -> ...
```

The full set of task states defined in the protocol:

| State            | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `submitted`      | Task has been created and is queued for execution.                  |
| `working`        | The agent is actively executing the task.                           |
| `input-required` | The agent needs additional input from the client before proceeding. |
| `completed`      | The task finished successfully. Artifacts are available.            |
| `failed`         | The task encountered an error.                                      |
| `canceled`       | The task was canceled via `tasks/cancel`.                           |

When payment is involved, the full request lifecycle is:

### 1. Authentication

The `Authorization: Bearer <token>` header is validated. If invalid or missing (and the request is not from a local loopback address), the agent responds with 401 Unauthorized.

### 2. Payment Gate

If the selling agent has payment enabled (`a2a.payment.enabled`) and the request method is `message/send`:

- If no `x-payment` or `x-payment-token` header is present, respond with 402 Payment Required. The pricing details, recipient address, chain, and token are returned in the JSON-RPC error body under `error.data`.
- If a payment header is present, verify the transaction on-chain:
  - The transaction must be confirmed (not pending).
  - The `to` address must match the agent's configured `x402.address`.
  - The transferred USDC amount must be greater than or equal to the minimum payment.
  - The transaction must not have been used for a previous task (replay protection).
- If verification fails, respond with 402 and an error description in the response body.
- Payment verification attempts are rate-limited per client IP (10 attempts per minute) to prevent DoS via fake tokens triggering expensive on-chain calls.

### 3. Task Creation

Once payment is verified (or no payment is required), a task is created with status `submitted` and a unique task ID is assigned. The status immediately transitions to `working` as execution begins.

### 4. Execution

The skill runs via a background sub-agent session. If the client used `message/stream`, they receive SSE updates during execution. Otherwise, the `message/send` response returns the task in `working` state and the client polls via `tasks/get`.

### 5. Completion

On success, the task moves to `completed` and the result artifacts are included. On failure, the task moves to `failed` with an error message. Note: failed execution after successful payment does not trigger an automatic refund -- dispute resolution is handled out-of-band.

---

## A2A Methods Reference

### `message/send`

Submit a message for execution. Creates a new task and returns it immediately.

**Params:**

```typescript
{
  message: {
    role: "user",
    parts: [{ type: "text", text: "..." }]
  },
  configuration?: {
    acceptedOutputModes?: string[],
    blocking?: boolean
  },
  metadata?: Record<string, unknown>
}
```

**Returns:** The created `A2aTask` object with `status.state` set to `working`.

### `message/stream`

Same parameters as `message/send`, but the response is an SSE stream. Events are emitted as the task progresses through states and produces artifacts.

**SSE event types:**

- `status` -- task state transition (includes `final: true` on terminal states)
- `artifact` -- a new artifact produced by the task

### `tasks/get`

Retrieve a task by ID.

**Params:**

```typescript
{
  id: string,
  historyLength?: number  // limit returned conversation history
}
```

**Returns:** The full `A2aTask` object with history and artifacts, or error code `-32001` (task not found).

### `tasks/list`

List tasks with optional filtering.

**Params:**

```typescript
{
  contextId?: string,   // filter by context
  status?: string,      // filter by state (e.g. "working", "completed")
  limit?: number,       // pagination limit
  offset?: number       // pagination offset
}
```

**Returns:** An array of `A2aTask` objects matching the filters.

### `tasks/cancel`

Cancel a running task. Only tasks in non-final states (`submitted`, `working`, `input-required`) can be canceled.

**Params:**

```typescript
{
  id: string;
}
```

**Returns:** The updated `A2aTask` with `status.state` set to `canceled`, or error code `-32002` if the task is not found or already in a final state.

### Forage bounty verbs (PLAN-29)

Nodes that post Forage bounties serve three additional JSON-RPC methods on the same `/a2a` endpoint. They are **free** (no x402 gate): the money flows poster to hunter at settlement, not per call. The lifecycle is claim, deliver, then poll for the verdict; verification runs poster-side against a sealed oracle spec whose hash was committed in the bounty envelope, so the acceptance criteria cannot be swapped after the fact.

`forage/*` verbs are also **exempt from A2A bearer auth**: hunters are anonymous peers with no way to hold the poster's token, so admission is gated on what the protocol can verify -- funding, trust-tier claim caps, stake, deliverable size caps, and prompt-injection scanning -- not identity. Two other verb families carry their own auth on the same endpoint (gated on `circles.enabled` — on by default — independently of `a2a.enabled`, PLAN-31/PLAN-41): `circle/*` verbs authenticate with an Ed25519-signed `circle/v1` envelope whose author must be an active circle member holding the verb's scope (default-deny; `circle/join` proves an invite secret instead), and `mailbox/*` verbs carry per-verb Ed25519 proofs (sender for post, recipient for poll/ack; additionally gated on `circles.mailbox.serve`). See `docs/network/circles.md` and `docs/protocol/circle-v1/SPEC.md`. Every other A2A method (`message/send`, `tasks/*`) keeps the bearer/loopback auth requirement. For hunters to reach these verbs at all, the poster must expose its gateway at a public URL and set `a2a.url` to it; bounties posted without a reachable `posterA2aUrl` are not autonomously huntable.

### Posting bounties (operator)

Posting is a **gateway RPC** (`forage.post`), not an A2A verb -- it commits the node's own money, so it sits behind gateway auth with the rest of the operator surface. It writes the poster-local row (with the sealed oracle spec, which never leaves the node) and gossips the funded BountyEnvelope v2 to `bitterbot/bounties/v1` in one atomic step; if the mesh publish fails, the local row is rolled back. The new bounty lands as `unverified` and clears the same funding sweep as any stranger's bounty (live USDC balance >= reward) before hunters see it as `open` -- operator bounties are deliberately not fast-pathed.

**Params:**

```jsonc
{
  "kind": "oneshot", // or "heartbeat"
  "category": "extraction", // free-form; used for directory scans
  "specPublic": "Extract ...", // public spec; heartbeat bounties MUST embed
  // the machine block with heartbeat terms,
  // posterA2aUrl, and the monitored url
  "oracleSpec": {
    // sealed; only its sha256 hash is gossiped
    "v": 1,
    "type": "json",
    "salt": "<random>",
    "requiredKeys": ["price"],
    "minItems": 2,
  },
  "rewardUsdc": 1,
  "claimStakeUsdc": 0, // optional
  "maxClaims": 1, // optional
  "deadline": 0, // optional epoch ms; 0 = none
  "expiresAt": 1799999999999, // epoch ms, or use expiresInHours
  "expiresInHours": 168, // convenience alternative to expiresAt
}
```

**Returns:** `{ bountyId, oracleCommitment, fundingProof, posterWallet, status: "unverified", note }`.

The poster identity convention is the node's **wallet address** (same as Night Shift's hunter identity), so DPSV self-loop exclusion holds even if your own node hunts your own bounty.

PLAN-30 G0.4 hardening: the attest funding sweep checks **aggregate** solvency (the wallet must cover the new reward plus its outstanding open obligations, minus what streams already paid), so one small balance can no longer "fund" many bounties at once. Judge-oracle passes above the $5 unilateral cap park at `held_review` and are resolved through the operator RPCs `forage.review` (list) and `forage.reviewRelease` (`{ settlementId, approve }`). Nodes running a Genesis seed program publish their treasury wallets in `forage.genesis.treasuryWallets`; `forage.stats` then reports seeded vs organic settled value as separate numbers (never blended), and each hunter's daily take from treasury-posted streams is capped (`forage.genesis.maxDailyTreasuryUsdcPerHunter`, default $1).

### Agent-facing discovery (the `forage` tool)

Every agent ships with a read-only `forage` tool so "are there any bounties on the network?" gets a live answer instead of a web search: `action=list` (open bounties in this node's directory), `stats` (the DPSV scoreboard), `mine` (bounties this node posted, with claim/settlement state), `hunts` (what Night Shift claimed and earned). The system prompt's Economic Identity section tells agents to reach for it whenever bounties, agent earnings, or the agent economy come up. The tool cannot post or claim -- posting stays behind the operator-authed `forage.post` RPC, and claiming stays with Night Shift's capped autonomous sweep.

#### `forage/claim`

Claim an `open` bounty. Rejected if the bounty is unverified, expired, fully claimed, you already hold an active claim, or the reward exceeds your trust-tier cap (tiers T0-T3 are earned through settled, counterparty-diverse history: caps $1 / $5 / $50 / uncapped).

**Params:** `{ bountyId, hunterPubkey, hunterWallet, stakeTxHash? }` (`hunterWallet` must be a `0x` EVM address; it is where the USDC payout lands).

**Returns:** `{ claimId, bountyId, status: "claimed", stakeUsdc, deadline, claimNonce }`. `claimNonce` (PLAN-30 G0.3) is a per-claim secret returned exactly once: check-ins that present `sealedDigest = sha256(claimNonce || contentHash)` prove they come from the nonce holder, which is what keeps anonymous strangers who learn a claim id from polluting the stream.

#### `forage/deliver`

Submit the deliverable for your claim. Content is capped at 128 KiB, passes a prompt-injection scan before storage (critical hits are rejected but the claim stays claimable for a clean resubmit), and is treated strictly as data for the oracle -- it is never executed.

**Params:** `{ bountyId, claimId, hunterPubkey, content, ref? }`

**Returns:** `{ claimId, status: "delivered", sha256 }`.

#### `forage/checkin`

Heartbeat streams only. A heartbeat bounty embeds its terms as a JSON block in `spec_public` (`{"heartbeat": {"cadenceSeconds", "perCheckUsdc", "alertBonusUsdc", "url"}, "posterA2aUrl": "https://..."}`) -- `url` names the monitored target and `posterA2aUrl` is the poster's A2A callback, which together make the bounty autonomously huntable by Night Shift nodes with no out-of-band discovery. Claiming one opens a stream, and each check-in reports one observation. Observations are hash-chained (`head_n = sha256(head_n-1 || contentHash)`), so history cannot be rewritten, and check-ins faster than half the agreed cadence are rejected. Unpaid checks are batched into `stream_check` payouts on the poster's revenue rail each consolidation tick; the bounty's `reward_usdc` is the stream's total budget, and the stream completes gracefully when it is spent.

**Params:** `{ bountyId, claimId, hunterPubkey, observation: { url?, contentHash, observedAt?, alert?, digestScheme?, simhash?, sealedDigest? } }`

**Returns:** `{ claimId, checksTotal, observationHead, streamStatus }`.

PLAN-30 G0 additions: `digestScheme` names the hash pipeline (`raw-v1` legacy sha256 of the body, or `norm-v1` which strips scripts/comments/asset cache-busters before hashing so page noise does not read as change); `simhash` is a 64-bit near-duplicate fingerprint the auditor uses to tolerate small drift; `sealedDigest` binds the observation to the claim nonce (a missing seal is accepted for legacy clients, an inconsistent one is rejected). Every check is written to a per-check observation log poster-side, and a random fraction is independently re-fetched and compared by the poster's auditor: 100% of a new hunter's first 10 checks, decaying to max(5%, 1/CV) as consecutive audits pass. Verdicts are two-tier by design: an honest mismatch on a live page merely resets the hunter's audit counter and pauses payment release, while provable fraud forfeits all held earnings. Alert check-ins (`alert: true`, claiming the content changed) are always audited, and the `alertBonusUsdc` bonus pays only when the audit confirms the change, so the flag cannot be farmed. Stream earnings release from the 48h hold only once the hunter has cleared the 10-check audit apprenticeship.

#### `forage/verdict`

Read-only poll of your claim's outcome. Only the claim's own hunter may read it.

**Params:** `{ bountyId, claimId, hunterPubkey }`

**Returns:** `{ claimId, claimStatus, verdict, settlementStatus, txHash }` -- `verdict` is `"pass"` once the oracle accepts; `settlementStatus` moves `queued -> paid` as the payout clears the 48h revenue hold and dispatches on-chain.

---

## A2A Client Usage

The Bitterbot A2A client handles the full discover-price-pay-execute cycle. Here is the typical usage pattern.

### Discover a Peer Agent

Fetch the Agent Card to learn what skills a peer offers and at what price:

```typescript
const response = await fetch("https://peer.bitterbot.example/.well-known/agent.json");
const agentCard = await response.json();

for (const skill of agentCard.skills) {
  const pricing = skill.extensions?.pricing;
  console.log(`${skill.name}: ${pricing?.priceUsdc ?? "free"} USDC`);
}
```

### Check Pricing

Before paying, confirm the current price for the specific skill you want:

```typescript
const skill = agentCard.skills.find((s) => s.id === "summarize-webpage");
const price = skill.extensions?.pricing?.priceUsdc;
const payTo = agentCard.extensions["x402-payment"].address;
```

### Execute a Task with Payment

Send the initial request, handle the 402, pay, and retry:

```typescript
import { createWalletClient, http, parseUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base

async function executeWithPayment(a2aUrl: string, input: string, authToken: string): Promise<any> {
  const taskPayload = {
    jsonrpc: "2.0",
    method: "message/send",
    id: crypto.randomUUID(),
    params: {
      message: {
        role: "user",
        parts: [{ type: "text", text: input }],
      },
    },
  };

  // Step 1: initial request (expect 402)
  const initialResponse = await fetch(a2aUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(taskPayload),
  });

  if (initialResponse.status !== 402) {
    // Skill is free or something unexpected happened.
    return initialResponse.json();
  }

  // Step 2: read pricing from the JSON-RPC error body
  const errorBody = await initialResponse.json();
  const paymentData = errorBody.error?.data;
  const price = paymentData?.pricing?.priceUsdc;
  const payTo = paymentData?.payTo;
  // paymentData also contains: chain ("base"), token ("USDC")

  if (!price || !payTo) {
    throw new Error("402 response missing pricing or payTo");
  }

  // Step 3: pay on-chain
  const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const amount = parseUnits(price.toString(), 6); // USDC has 6 decimals

  const txHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: [
      {
        name: "transfer",
        type: "function",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "transfer",
    args: [payTo as `0x${string}`, amount],
  });

  // Step 4: wait for confirmation, then retry with payment proof
  // In production, wait for at least 1 confirmation.

  // Build a SIGNED payment proof token. The signature binds the proof to the
  // specific (recipient, txHash, amount) tuple so a leaked txHash cannot be
  // replayed by another agent against a different recipient.
  const timestamp = Date.now();
  const canonical = [
    "bitterbot-x402",
    "v1",
    payTo.toLowerCase(),
    txHash.toLowerCase(),
    String(price),
    account.address.toLowerCase(),
    String(timestamp),
  ].join(":");
  const signature = await account.signMessage({ message: canonical });

  const paymentToken = Buffer.from(
    JSON.stringify({
      version: "v1",
      txHash,
      amount: price,
      sender: account.address,
      recipient: payTo,
      timestamp,
      signature,
    }),
  ).toString("base64");

  const paidResponse = await fetch(a2aUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
      "X-Payment-Token": paymentToken,
    },
    body: JSON.stringify({ ...taskPayload, id: crypto.randomUUID() }),
  });

  return paidResponse.json();
}
```

### Collect the Result

The response follows standard JSON-RPC 2.0 structure with the A2A task envelope:

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "result": {
    "id": "task-id",
    "status": {
      "state": "working",
      "timestamp": "2026-03-28T12:00:00.000Z"
    },
    "history": [
      {
        "role": "user",
        "parts": [{ "type": "text", "text": "Summarize https://example.com" }]
      }
    ]
  }
}
```

The initial `message/send` response returns the task in `working` state. Poll with `tasks/get` to check for completion:

```json
{
  "jsonrpc": "2.0",
  "id": "poll-id",
  "result": {
    "id": "task-id",
    "status": {
      "state": "completed",
      "timestamp": "2026-03-28T12:00:05.000Z"
    },
    "artifacts": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Summary of the webpage content..."
          }
        ]
      }
    ]
  }
}
```

---

## Daily Spend Limits and Safety Guards

The A2A client enforces configurable spending limits to prevent runaway costs when making outbound purchases:

```jsonc
{
  "a2a": {
    "marketplace": {
      "client": {
        // Maximum USDC to spend per outbound A2A task. Default: 0.50
        "maxTaskCostUsdc": 0.5,
        // Maximum USDC to spend per day on outbound tasks. Default: 2.00
        "dailySpendLimitUsdc": 2.0,
        // Task timeout in ms. Default: 60000
        "taskTimeoutMs": 60000,
      },
    },
  },
}
```

**Per-task cap (`maxTaskCostUsdc`):** Before initiating payment for any skill, the agent checks that the quoted price does not exceed `maxTaskCostUsdc`. If it does, the task is rejected locally without sending any on-chain transaction.

**Daily cap (`dailySpendLimitUsdc`):** The agent tracks cumulative spending over a rolling 24-hour window. If a new purchase would push the total past `dailySpendLimitUsdc`, the task is rejected. The window resets continuously -- it is not a fixed calendar day.

When a limit is hit, the agent logs a warning and the task fails with a descriptive error. No funds are spent. You can adjust limits at any time through the configuration file; changes take effect immediately without restarting the agent.

Additional safety guards:

- **Replay protection.** Each transaction hash can only be used for a single task. The selling agent maintains a set of consumed transaction hashes and rejects duplicates.
- **Payment rate limiting.** The selling agent rate-limits payment verification attempts to 10 per minute per client IP, preventing denial-of-service attacks via fake payment tokens that trigger expensive on-chain verification calls.
- **Testnet mode.** When the network is set to Base Sepolia, all transactions use test USDC. No real funds are at risk. Always test marketplace integrations on testnet before switching to mainnet.

---

## On-Chain Verification via viem

The selling agent verifies payments on-chain using viem. Here is the core verification logic.

### Fetching the Transaction Receipt

```typescript
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { base } from "viem/chains";

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function verifyPayment(
  txHash: `0x${string}`,
  expectedRecipient: string,
  expectedAmountUsdc: number,
): Promise<{ valid: boolean; reason?: string }> {
  // 1. Fetch the transaction receipt
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

  if (receipt.status !== "success") {
    return { valid: false, reason: "Transaction reverted." };
  }

  // 2. Parse Transfer event logs from the USDC contract
  const transferEvent = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  );

  const transferLogs = receipt.logs.filter(
    (log) => log.address.toLowerCase() === USDC_ADDRESS.toLowerCase(),
  );

  if (transferLogs.length === 0) {
    return { valid: false, reason: "No USDC transfer found in transaction." };
  }

  // 3. Decode and validate each Transfer log
  for (const log of transferLogs) {
    // ERC-20 Transfer: topics[1] = from, topics[2] = to, data = value
    const to = ("0x" + log.topics[2]!.slice(26)).toLowerCase();
    const value = BigInt(log.data);
    const amountUsdc = Number(formatUnits(value, 6));

    if (to === expectedRecipient.toLowerCase() && amountUsdc >= expectedAmountUsdc) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: "No matching transfer to the expected recipient with sufficient amount.",
  };
}
```

### What the Verification Checks

| Check              | Detail                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transaction status | `receipt.status` must be `"success"`. Reverted transactions are rejected.                                                                                                                                                                                    |
| Contract address   | The log must originate from the USDC contract on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).                                                                                                                                                        |
| Recipient          | The `to` address in the Transfer event must EQUAL the selling agent's configured `x402.address` (exact 20-byte match). The previous substring check was tightened in 2026-04.                                                                                |
| Amount             | The transferred value (decoded from the log data, 6 decimal places for USDC) must be greater than or equal to the minimum payment.                                                                                                                           |
| Uniqueness         | The transaction hash must not have been used for a prior task (UNIQUE index on `marketplace_purchases.tx_hash`).                                                                                                                                             |
| Signature (v1)     | When the token includes a `version: "v1"` and `signature`, the seller verifies via EIP-191 `recoverMessageAddress` and confirms the recovered address matches the on-chain Transfer's `from`. Unsigned tokens are still accepted with a deprecation warning. |

If any check fails, the selling agent responds with 402 and a JSON-RPC error body describing the failure reason. The buying agent can then retry with a corrected payment.

---

## Remote Execution Is Hermetic (PLAN-43 Phase 1)

An inbound `message/send` or `message/stream` task executes an agent turn on
this node driven by a REMOTE caller's input. That turn is hermetic:

- It gets NO tools by default: it is a pure model turn over the prompt. The
  operator can grant tools via `a2a.remoteExecution.tools.allow`, but a
  hardcoded floor (wallet, shell/exec/process, session spawning and
  steering, cron, node control, browser/computer use, outbound messaging,
  web egress, memory/skill state) can never be granted back to a remote
  caller, by config or otherwise. The Docker session sandbox
  (`agents.defaults.sandbox`) remains available as a hard process boundary
  on top.
- It carries a real server-side wall clock (`timeoutSeconds`, default 600):
  the run aborts at the deadline rather than surviving its reporting
  window.
- Inbound text is size-capped (`maxInputChars`) BEFORE the payment gate, so
  an oversize request is refused rather than charged, then injection-scanned
  and wrapped as untrusted external content.
- The result is size-capped (`maxOutputChars`) and injection-scanned before
  it returns to the caller; a critical payload is withheld.
- `message/stream` passes the same x402 payment gate as `message/send`.

## Metered Skill Invocation and Task Access (PLAN-43 Phase 1)

- **Exact-ID invocation.** A `message/send` (or `message/stream`) request
  may name a listed skill via `params.skillId` (or
  `params.metadata.skillId`). The task then executes that skill's
  definition against the caller's request, and the payment gate prices the
  call at the skill's listed per-call price (never below
  `payment.x402.minPayment`). An id that is not currently listed for sale
  is refused with 404 before any payment is taken. There is no fuzzy
  matching: a purchase is attributed to a skill only when the buyer named
  its exact id.
- **Per-task access tokens.** The `message/send` create response carries a
  per-task `accessToken` (reusable across polls for that task's lifetime);
  `message/stream` delivers the same fields in its first SSE event
  (`event: task`), so a dropped stream never orphans a paid result. Under
  `authentication.type: "none"`, `tasks/get` and `tasks/cancel` require
  that token (`params.accessToken`) — without it, callers get
  `TASK_NOT_FOUND`, so task ids cannot be probed and one buyer can never
  read another buyer's paid result. `tasks/list` requires a real credential
  (bearer token) or a local direct request. Task reads never include the
  token; keep it from the create response.
- The outbound client (`services/a2a-client.ts`) polls `tasks/get` with the
  access token until the task reaches a final state, so buyers receive the
  actual result rather than the initial "working" snapshot.
- When `payment.enabled` is false the whole surface is free, including
  named-skill invocation — enabling payments is what puts the meter on.
  Known residual until Phase 2's quote flow: a listing price raised between
  a 402 quote and the buyer's paid retry is rejected as underpayment after
  the USDC settled; the client's price cap bounds the loss to the quoted
  amount, and re-invoking after the price change works.

## Listing Integrity: Lineage and Royalty (PLAN-43 Phase 3)

- **Lineage-laundering gate (seller-side, good-faith).** Opting a skill
  into sale content-addresses it (SHA-256, exposed as `contentSha256` on
  listings) and compares it against the local commons (peer-origin and
  free-shared skills, any lifecycle). Evidence order: an exact or
  normalized content-hash match (frontmatter, provenance trailers, case
  and whitespace stripped) is decisive on its own; otherwise embedding
  cosine against commons rows embedded by the same model. A copy or
  near-duplicate (cosine 0.92 or higher) that does not cite the source
  author's pubkey as lineage is refused and recorded in
  `listing_refusals` (bounded per crystal). Citing a crystal id does not
  count: the refusal discloses it and no payout can reach it. A candidate
  whose embedding is not indexed yet is refused (fail closed) whenever the
  commons has embeddings to compare against; an empty or unembedded
  commons needs no comparison. Similarity between 0.80 and 0.92 is flagged
  on the listing (`lineage_flagged`) but allowed. A match against this
  node's own free-shared skill (no peer author) owes nobody lineage. The
  gate re-runs on every listing refresh, pulling a listing that no longer
  passes.
- **Honest scope.** The gate runs on the seller's own node against the
  seller's own database. It binds unmodified nodes and catches verbatim
  and near-verbatim copies; a full paraphrase lands below the threshold.
  The receiver-side attestations below are the enforcement that does not
  depend on the seller.
- **Citing lineage.** `marketplace.listForSale` accepts
  `{ "crystalId": "...", "lineage": ["<author pubkey>", ...] }`. The cited
  authors are merged into the crystal's provenance chain (a union: citing
  can add an author, never erase recorded contributors), the chain is
  restored if the gate refuses, and the author the gate actually
  identified is stored on the listing (`lineage_author_pubkey`). The
  revenue split pays the author share from that evidence, not from
  whatever chain the seller supplied.
- **Registry royalty (accrued, unpaid by default).** A sale of a skill
  imported from a registry (agentskills.io, matched by the content hash in
  its `.provenance.json`, then by frontmatter name) reserves
  `skills.agentskills.royaltyBps` for the registry as a `registry_royalty`
  share before the 70/20/10 publisher/author/contributor split. The share
  is queued under the recipient `agentskills.io` and pays out only when
  `skills.agentskills.royaltyWallet` is configured; until then it stays
  queued: never silently kept, never silently dropped.

## Receiver-Side Attestations (PLAN-43 Phase 3)

Trust in a skill never rests on the seller's reported scores. In tasks
mode, the evolution loop's housekeeping sweep re-scores peer-origin skills
on THIS node's corpus: the seeded canonical regression suite plus the
node's private capability suite, skill injected (candidate) vs the agent
as-is (incumbent), under the same sign-test gate skills face for
promotion. The verdict is signed with the node's device identity as an
attestation keyed by the skill's content SHA-256 (`attest/v1`;
protocol-prefixed canonical JSON, Ed25519, closed schema with every
numeric field range-checked) and stored in `skill_attestations`.

- **Only measurements are evidence.** A hold (no capability suite yet,
  runner failure, too few tasks) is never signed, stored, or aggregated;
  the sweep short-circuits entirely when the node has no capability
  tasks. A skill is re-attested when the private suite or the canonical
  corpus generation changes, and only current-generation verdicts count in
  the aggregate.
- **Bounded, fair, safe.** One skill per author per pass (a peer pushing
  fresh edits daily cannot own the rollout budget), oldest unattested
  first, at most one per pass by default. Peer text the injection scanner
  rates medium or worse is never executed. Validation rollouts run in
  sessions the trust classifier marks untrusted (no canonical pins, no
  standing directives), excluded from transcript ingestion, and under the
  same tool floor as remote A2A callers (no wallet, shell, sessions,
  messaging, or egress tools). The attester key is loaded read-only: a
  transient read failure disables attestation for the pass instead of
  rotating the identity.
- **Aggregation.** Reputation-weighted, weight-trimmed mean (the lowest
  and highest 20% of attester weight are discarded once five or more
  TRUSTED attesters have measured). Weights: own node and
  `a2a.attestation.trustedAttesters` count 1, `blockedAttesters` count 0,
  everyone else `unknownAttesterWeight` (default 0.05), and all unknown
  attesters together may weigh at most 25% of the trusted weight present.
  Minting identities is free, so two things, not the per-key weight, are
  the defense: that cap bounds how far strangers can move a trusted
  verdict, and unknown-only evidence never produces a score at all (a
  skill nobody trusted has measured shows `score: null` with an
  `unverified` count). The corpus-generation filter is a freshness
  filter, not proof: `corpus_version` and `private_suite_sha256` are
  claims a signer makes about itself. Any new failure scores -1
  regardless of wins. Verdicts are recorded and surfaced (marketplace
  entries carry `attestation` with the counted attesters, and
  `sortBy: "attested"` ranks by it with a confirmed regression below
  "not yet measured"); deactivating a skill on a regression verdict is an
  operator decision, not automatic.
- **Exchange.** `skill/attest.list { contentSha256 }` and
  `skill/attest.submit { attestation }` are A2A verbs served from the
  memory store (independent of the marketplace flag) without bearer auth
  (records carry their own signatures; verdicts about a content hash are
  public evidence, and `list` therefore reveals which skills a node holds
  and the attesting model name). Submits are verified before storage,
  accepted only for skills this node holds, refused for blocked attesters,
  rate-limited per client, and capped (64 attesters per skill, 50k rows;
  evidence older than 90 days is pruned). Housekeeping pushes this node's
  attestations for its most recent peer skills to `a2a.attestation.peers`
  and pulls theirs, verifying every record, reading at most 256 KB per
  response, with a per-peer deadline. The exchange runs in any validation
  mode; only re-scoring needs tasks mode. A peer's copy of this node's
  own record never overwrites it. Peers may not be loopback or link-local
  addresses.

## Commerce Standing, Freeze, and the Bond Ledger (PLAN-43 Phase 3)

- **Commerce standing from real outcomes.** Every outbound A2A task this
  node sends is recorded per peer endpoint (URL origin) in
  `commerce_reputation`: answered, unreachable (network error or 5xx), or
  failed, with latency. This node's own refusals (price cap, daily spend
  cap, its own wallet) and HTTP 4xx answers (payment required, auth, rate
  limit) are never scored against the peer. Answer rate and uptime are
  therefore this node's own observations, never a peer's claim. A peer
  under a 50% answer rate over five or more attempts since its last
  quarantine is quarantined for 24 hours: the A2A client refuses to spend
  on it until the window passes, and the counting window restarts so a
  recovered peer earns its way back in a handful of calls. Honest scope:
  this is an endpoint throttle protecting this node's spend, keyed by
  origin, which a peer can evade with a new host or port at no cost; it
  is not a network reputation. Quarantine is separate from the
  skill-ingestion ban (a flaky seller keeps its free-skill standing; a
  banned publisher keeps nothing: its skills leave browse, trending,
  recommendations, and detail with the ban). The `a2a_status` tool
  (`scope: "peers"` or `"all"`) and the `marketplace.commerce` RPC (read
  scope) surface the standings and quarantine reasons.
- **Listings kill switch.** `a2a.marketplace.freezeListings: true` empties
  the sellable set immediately (invoke and listing RPCs read empty, and
  prices leave the agent card at the next request; callers may hold a
  cached card for up to five minutes). It is read from the live config
  file; no restart is needed.
- **Slashable seller bond, as a ledger.** `marketplace.postBond
{ sellerPubkey, amountUsdc }` (operator write scope) records a stake at
  risk; no funds move anywhere in this path (invariant I7). The trigger is
  corroborated regression evidence, not a single failing task: this
  node's own regression attestation on a peer-origin skill from that
  seller, with either two or more failing tasks or a second attester's
  regression verdict. The evolution housekeeping pass (any validation
  mode) records the verdict once per (skill, seller), marks the seller's
  posted bonds slashed with the evidence, and quarantines the seller by
  pubkey for 30 days. That pubkey quarantine blocks the A2A client only
  when it knows the seller's pubkey for an endpoint: pass `peerPubkey` (a
  marketplace entry's `authorPeerId`) to the `a2a_client` tool, and the
  endpoint remembers it; an endpoint dialed without a pubkey is not
  joined to fraud verdicts. `marketplace.bonds` lists the ledger and the
  verdict count (a verdict against a seller with no bond slashes nothing
  but is still recorded and surfaced). Releasing a bond is a ledger
  action too. Turning any of this into money movement is a separate,
  flag-gated decision for payments counsel.

## Contribution Status (PLAN-43 Phase 4)

Free contribution is rewarded with standing, never with money (invariant
I5; there is no tip, bounty, or payout on the commons). A contributor's
standing on this node is recomputed at every consolidation pass from
signals this node itself verified:

- skills of theirs this node accepted and holds
- real executions of those skills here, and how many succeeded
- attestations with measured verdicts on those skills (accepted versus
  regression) from this node and from `a2a.attestation.trustedAttesters`
- lineage credits: paid listings here whose gate evidence names them as
  the source author
- penalties: corroborated regression verdicts and bans

Downloads, stars, views, and any self-reported number never enter
(invariant I6). Executions credited to a skill are capped at five per
skill, and executions the tool hook attributed by tool-name match are
not counted at all (a skill named after a built-in tool would otherwise
inherit that tool's every call). Tiers are `newcomer`, `contributor`,
`trusted_contributor`, `core`, and `flagged`. Every tier above
`contributor` requires at least one measured accepted verdict; execution
counts alone never climb past `contributor`. A contributor with more
regression than accepted verdicts drops back to `newcomer`. A fraud
verdict or ban flags them, and a flag is sticky: only the operator's
`marketplace.contributorClearFlag` (write scope) removes it. Tiers unlock
privileges, not cash:

| Tier                | Ingestion trust floor | Publication-rate lift | Circle invite uses |
| ------------------- | --------------------- | --------------------- | ------------------ |
| newcomer / flagged  | none                  | 1x                    | 1                  |
| contributor         | none                  | 2x                    | 3                  |
| trusted_contributor | trusted               | 2x                    | 3                  |
| core                | trusted               | 3x                    | 10                 |

The trust floor lifts `untrusted` or `provisional` ingestion trust to
`trusted`, never to `verified` (that stays earned through reputation or
the operator's trust list), and an active publication-spike anomaly
still caps a peer at `provisional`. Operators should know what
`trusted` means downstream: the skill capability gate gives trusted
authors a wider baseline (declared network hosts and filesystem access
beyond the workspace) and, under `ingestPolicy: "auto"`, their skills
skip the review quarantine. That is why the floor is reachable only
through a measured verdict on this node's own corpus, never through
counts. The rate lift multiplies the anomaly detector's threshold.
Invite uses apply to target-bound circle invites created for that
contributor; a ban drops them to one and revokes open invites already
minted for that peer. Stale tiers are cleared at every recompute, so a
peer whose skills are gone keeps nothing. Marketplace entries carry the
author's `contributor` tier and rank; `marketplace.contributors` (read
scope) lists standings and the privilege table, with `recompute: true`
to refresh on demand (throttled to once a minute). A fraud verdict in
the evolution pass re-derives standings immediately.

## Selling Is Opt-In Per Skill (PLAN-43 Phase 0)

The paid listing pool is fully decoupled from free skill propagation:

- A skill becomes a paid-listing candidate only when its crystal carries the
  explicit `for_sale` flag. Free propagation (`publish_visibility: "shared"`)
  never implies a paid listing, and vice versa; a skill can be both
  free-propagated and for sale, but nothing auto-enrolls.
- Opt in or out via the gateway RPCs `marketplace.listForSale` and
  `marketplace.delist` (both take `{ "crystalId": "…" }`, and both require
  the `operator.write` scope). Opting in makes the skill a candidate; it is
  priced and quality-gated (minimum executions and success rate) at the next
  consolidation refresh, roughly every 30 minutes. Delisting removes the
  paid listing immediately, though an already-served agent card may be
  cached by callers for up to 5 minutes (`Cache-Control: max-age=300`).
  Peer-imported crystals cannot be listed until the provenance-split wiring
  ships (Phase 1): a sale must never silently keep 100%.
- Listings rank by PLAN-42 validation verdicts: canonical-corpus verdicts
  first, then grown-corpus verdicts, then unvalidated skills. Never by
  price, downloads, or other farmable counts.
- The agent card advertises no skills unless the operator sets
  `a2a.skills.expose: "all"` or an explicit allowlist.

## Configuration Reference

The `a2a` block in `~/.bitterbot/config.jsonc`:

```jsonc
{
  "a2a": {
    "enabled": true, // opt-in (V1 default flip): required to serve the Agent Card + message/tasks verbs
    "name": "My Bitterbot Node", // displayed in the agent card; defaults to ui.assistant.name
    "description": "…", // free-text description for callers
    "url": "https://agent.example", // public URL when behind NAT/proxy; otherwise inferred
    "authentication": {
      "type": "bearer", // "bearer" | "none"
      "bearerToken": "…", // optional; falls back to gateway auth token
    },
    "skills": {
      "expose": "none", // "all" | "none"; DEFAULT "none" (PLAN-43 Phase 0: advertising skills is opt-in)
      "allowlist": ["summarize-webpage"], // implies exposure of exactly these skills when "expose" is unset
    },
    "remoteExecution": {
      // PLAN-43 Phase 1: hermetic execution of inbound task turns
      "tools": { "allow": [], "deny": [] }, // default: a remote turn gets NO tools
      "maxInputChars": 32000, // oversize requests are refused before the payment gate
      "maxOutputChars": 64000, // results truncate beyond this
      "timeoutSeconds": 600, // server-side wall clock on the spawned turn
    },
    "attestation": {
      // PLAN-43 Phase 3: receiver-side attestation exchange
      "enabled": true, // serve skill/attest.* and sync with peers
      "peers": ["https://peer.example"], // A2A base URLs to push/pull attestations with; default []
      "trustedAttesters": ["ed25519:<hex>"], // device attester pubkeys weighing 1.0
      "blockedAttesters": [], // ignored entirely
      "unknownAttesterWeight": 0.05, // everyone else; their total is capped at 25% of trusted weight
    },
    "payment": {
      "enabled": false, // default derives from wallet readiness: on when full CDP creds present, off otherwise; explicit value wins
      "x402": {
        "address": "0x…", // optional; defaults to the node's own CDP wallet address
        "minPayment": 0.01, // floor in USDC
      },
    },
    "marketplace": {
      "enabled": true,
      "freezeListings": false, // PLAN-43 Phase 3 kill switch: true = nothing advertised or sellable (live)
      "pricing": { "basePriceUsdc": 0.01 },
      "client": {
        // outbound spend caps
        "maxTaskCostUsdc": 0.5,
        "dailySpendLimitUsdc": 2.0,
        "taskTimeoutMs": 60000,
      },
    },
    "erc8004": {
      // optional onchain identity (EIP-8004, mainnet 2026-01-29)
      "enabled": false,
      "tokenId": "42", // ERC-721 tokenId from the Identity Registry
      "chain": "base", // "base" | "base-sepolia"; canonical registry inferred
    },
  },
}
```

The Zod schema validates this block at config load. Missing `payment.x402.address` while `payment.enabled: true` is rejected with a clear error — no silent fallthrough to `payTo: ""`.

---

## Agent Introspection (`a2a_status` tool)

The agent has a built-in tool, `a2a_status`, that returns a read-only snapshot of the A2A subsystem so it can answer questions about activity without guessing:

```typescript
{
  scope?: "summary" | "inbound" | "outbound" | "earnings" | "peers" | "all",
  recentLimit?: number,                                   // default 5, max 50
  peerLookup?: { erc8004TokenId: string, chain?: "base" | "base-sepolia" }
}
```

Default scope (`summary`) is cheap — config snapshot, today's inbound/outbound/earnings totals, your own ERC-8004 reputation if configured. No chain reads for arbitrary peers.

`peers` scope or an explicit `peerLookup` triggers an ERC-8004 Reputation Registry read on Base. Results are TTL-cached in-memory per `(tokenId, chain)` key. Tune the TTL via `a2a.erc8004.cacheTtlMs` (default `300000` = 5 min; set `0` to disable caching).

The tool also returns short, paraphrasable `hints[]` strings for the agent to surface when relevant — e.g. "Payment gate is off", "Daily outbound spend cap reached", "Pending revenue payouts: $0.05 held for the 48h dispute window". The agent's system prompt nudges it to call `a2a_status` whenever the user asks about A2A activity, earnings, spend, or peer reputation.

---

## Further Reading

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/) -- canonical Google A2A reference.
- [x402 Protocol Specification](https://github.com/coinbase/x402) -- canonical Coinbase x402 reference and v2 transport spec.
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004) -- identity, reputation, validation registries.
- [Skill Marketplace Guide](./skill-marketplace.md) -- user-facing overview of marketplace features, pricing configuration, and security.
