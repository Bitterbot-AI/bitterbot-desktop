#!/usr/bin/env node
/**
 * PLAN-47 Phase 0 (invariant I4): freeze the value-moving surface.
 *
 * Every code path that actually moves value must stay inside a known, small set
 * of files, so that when the AP2 mandate layer (Phase 1) and the Policy Decision
 * Record enforcement gate (Phase 4) land, routing *all* spend through the gate is
 * mechanical and a new unguarded payment path cannot sneak in unnoticed. This is
 * the same freeze-the-surface move PLAN-46 made for `chunks` writes
 * (scripts/check-chunk-writes.mjs): establish the current legitimate callers as
 * the allowlist; a NEW caller in any other file fails lint.
 *
 * Two value-moving patterns are enforced:
 *   A. outbound USDC spend   — `.sendUsdc(` / `.payForResource(` method calls
 *   B. onchain EIP-3009 pull — `functionName: "transferWithAuthorization"`
 *
 * When Phase 1/4 land, the allowlist SHRINKS to the gated wrapper — it does not
 * grow. Adding a file here without routing it through the mandate/enforcement
 * gate defeats I4; do that only with an explicit PLAN-47 note.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";

// Pattern A: outbound spend method calls. The interface signature and the
// `async sendUsdc(` definition in wallet-service.ts have no leading dot, so they
// do not match; only actual `x.sendUsdc(...)` / `x.payForResource(...)` calls do.
const SPEND_CALL_RE = /\.(sendUsdc|payForResource)\s*\(/g;
const SPEND_ALLOW = new Set([
  "src/agents/tools/wallet-tool.ts", // the gated wallet tool (opt-in + session caps)
  "src/services/a2a-client.ts", // A2A auto-pay for a 402-gated peer task
  "src/services/wallet-service.ts", // the service itself (definition + internal use)
  "src/gateway/server-methods/wallet.ts", // the wallet gateway RPC (pay_for_resource)
  "src/memory/manager.ts", // PLAN-8 revenue/bounty payout dispatch (markPaymentProcessed)
  // Future: "src/payments/ap2/gate.ts" — the mandate+enforcement wrapper (Phase 1/4).
]);

// Pattern B: the onchain EIP-3009 capture. Matching the functionName string (not
// bare mentions) avoids the doc-comment references in settlement.ts / bounty-funding.ts.
const EIP3009_RE = /functionName:\s*["']transferWithAuthorization["']/g;
const EIP3009_ALLOW = new Set([
  "src/commerce/cdp-adapters.ts", // the sole EIP-3009 transferWithAuthorization submitter
]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      out.push(...walk(p));
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

const violations = [];
for (const file of walk(ROOT)) {
  const norm = file.replaceAll("\\", "/");
  const src = readFileSync(file, "utf-8");

  if (!SPEND_ALLOW.has(norm)) {
    for (const m of src.matchAll(SPEND_CALL_RE)) {
      violations.push(
        `${norm}:${lineOf(src, m.index)}  value-moving call ${m[0]} — route spend through the PLAN-47 mandate/enforcement gate`,
      );
    }
  }
  if (!EIP3009_ALLOW.has(norm)) {
    for (const m of src.matchAll(EIP3009_RE)) {
      violations.push(
        `${norm}:${lineOf(src, m.index)}  onchain transferWithAuthorization outside cdp-adapters.ts`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("check-payment-paths: unguarded value-moving paths (PLAN-47 I4):");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(
  `check-payment-paths: OK (I4 holds; spend confined to ${SPEND_ALLOW.size} files, EIP-3009 capture to ${EIP3009_ALLOW.size})`,
);
