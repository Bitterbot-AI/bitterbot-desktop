/**
 * Aubaine Stage-1 pilot harness (PLAN-26 / docs/protocol/aubaine-v1).
 *
 * Stands up the REAL coordination stack — ClearinghouseService, DemandMatcher,
 * ThresholdSettlement — against an in-memory DB, and drives one full group-buy
 * cycle end to end:
 *
 *     offer + intents  ->  syndicate forms at MOQ  ->  each buyer re-verifies
 *     and signs two EIP-3009 legs  ->  coordinator confirm-then-captures  ->
 *     portable signed settlement receipts.
 *
 * The ONLY mock is the on-chain seam (`SettlementExecutor` / `Eip3009Signer`):
 * the exact interface Stage 2 swaps for the live CDP / x402 EIP-3009 signer. No
 * real money, no mesh, no chain — so you can watch the whole state machine today.
 *
 * It doubles as an executable invariant check: Scenario B asserts the three
 * safety properties and the script exits non-zero if any regress.
 *
 *   pnpm aubaine:demo        (or: node --import tsx scripts/aubaine-demo.ts)
 */
import { DatabaseSync } from "node:sqlite";
import { ClearinghouseService } from "../src/commerce/clearinghouse.js";
import {
  type Envelope,
  generateKeyPair,
  type KeyPair,
  makeEnvelope,
  pubkeyId,
  verifyEnvelope,
} from "../src/commerce/envelope.js";
import { coordinatorFeeBps } from "../src/commerce/feature.js";
import {
  buildCommitResponse,
  type CommitRequestBody,
  type Eip3009Authorization,
  type Eip3009Signer,
  type QuoteProvider,
  ReverificationError,
  type SettlementExecutor,
  ThresholdSettlement,
} from "../src/commerce/settlement.js";
import { canonicalizeSku } from "../src/commerce/sku.js";
import { ensureMemoryIndexSchema } from "../src/memory/memory-schema.js";
import { runMigrations } from "../src/memory/migrations.js";

// ── Scenario: a real internal-mesh SKU every node actually needs ───────────
// Pooled Base RPC archive access. Solo retail is what one node pays alone; the
// MOQ unit price is the windfall the swarm unlocks.
const NOW = 1_000_000;
const SKU_SPEC = {
  category: "base-rpc-access",
  tier: "archive",
  quota_cu_per_month: 50_000_000,
  term_months: 1,
};
const SKU = canonicalizeSku(SKU_SPEC);
const SKU_DESCRIPTION = "Base RPC archive access, 50M compute-units/mo, 1-month term (pooled)";
const SUPPLIER_WALLET = "0xfee0000000000000000000000000000000000fee";
const SUPPLIER_A2A_URL = "https://rpc-supplier.example/a2a";
const SOLO_PRICE_USDC = 49; // retail per node, bought alone
const POOLED_PRICE_USDC = 29; // unit price at MOQ
const DEPOSIT_BPS = 4000; // 40% captured at strike, rest at the service-start milestone
const MOQ = 5;

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

// One Bitterbot node acting as a buyer: an Ed25519 protocol identity + a Base
// wallet that signs EIP-3009 authorizations.
interface Buyer {
  key: KeyPair;
  wallet: string;
  honest: boolean; // a dishonest coordinator path: buyer's re-verify will mismatch
}

function makeBuyers(n: number, dishonestIndex = -1): Buyer[] {
  return Array.from({ length: n }, (_, i) => ({
    key: generateKeyPair(),
    wallet: `0xb00000000000000000000000000000000000000${i}`,
    honest: i !== dishonestIndex,
  }));
}

/** Mock on-chain signer — the seam Stage 2 replaces with the CDP/x402 signer. */
function signerFor(wallet: string): Eip3009Signer {
  return {
    walletAddress: () => wallet,
    signTransfer: async (p) => ({ ...p, signature: `0x${"11".repeat(65)}` }),
  };
}

/** Mock capture — returns a fake tx hash and counts calls so we can prove
 *  confirm-then-capture really captured nothing on an aborted strike. */
function makeExecutor(): SettlementExecutor & {
  captures: Eip3009Authorization[];
} {
  return {
    captures: [],
    async capture(auth: Eip3009Authorization) {
      this.captures.push(auth);
      return {
        txHash: `0x${"aa".repeat(31)}${this.captures.length.toString(16).padStart(2, "0")}`,
      };
    },
  };
}

function offerEnvelope(supplier: KeyPair, moq: number): Envelope {
  return makeEnvelope(
    "offer",
    {
      sku_canonical: SKU,
      sku_description: SKU_DESCRIPTION,
      unit_price_usdc: POOLED_PRICE_USDC,
      moq,
      lead_time_days: 0,
      supplier_wallet: SUPPLIER_WALLET,
      supplier_a2a_url: SUPPLIER_A2A_URL,
      deposit_bps: DEPOSIT_BPS,
      expires_at: NOW + 100_000,
    },
    supplier,
    NOW,
  );
}

function intentEnvelope(buyer: Buyer): Envelope {
  return makeEnvelope(
    "intent",
    {
      sku_canonical: SKU,
      sku_description: "need archive RPC for my agent",
      max_price_usdc: SOLO_PRICE_USDC, // willing to pay up to solo retail; pool beats it
      qty: 1,
      lead_time_max_days: 30,
      expires_at: NOW + 100_000,
      mandate: {
        max_total_usdc: SOLO_PRICE_USDC,
        settlement: "eip3009",
        buyer_wallet: buyer.wallet,
        chain: "base",
        token: "usdc",
      },
    },
    buyer.key,
    NOW,
  );
}

interface SyndicateMember {
  id: string;
  buyer_pubkey: string;
}

interface RunResult {
  syndicateId: string;
  invited: number;
  committed: number;
  settledCount: number;
  strikeOk: boolean;
  strikeReason?: string;
  executor: ReturnType<typeof makeExecutor>;
}

/** Run one full cycle: ingest -> form -> commit -> strike. */
async function runCycle(
  db: DatabaseSync,
  supplier: KeyPair,
  coordinator: KeyPair,
  buyers: Buyer[],
): Promise<RunResult> {
  const service = new ClearinghouseService(db, pubkeyId(coordinator));
  service.subscribe((ev) =>
    console.log(
      `   » event: ${ev.type} (syndicate ${ev.syndicate.id.slice(0, 8)}, moq ${ev.syndicate.moq})`,
    ),
  );

  service.submitOffer(offerEnvelope(supplier, MOQ), NOW);
  for (const b of buyers) service.submitIntent(intentEnvelope(b), NOW);

  const syndicate = service.listSyndicates(SKU)[0];
  if (!syndicate) {
    return {
      syndicateId: "",
      invited: 0,
      committed: 0,
      settledCount: 0,
      strikeOk: false,
      strikeReason: "no syndicate formed (covered qty < MOQ)",
      executor: makeExecutor(),
    };
  }

  const members = db
    .prepare(`SELECT id, buyer_pubkey FROM group_buy_members WHERE syndicate_id = ?`)
    .all(syndicate.id) as unknown as SyndicateMember[];
  const byPubkey = new Map(buyers.map((b) => [pubkeyId(b.key), b]));

  const executor = makeExecutor();
  const settlement = new ThresholdSettlement(db, executor, {
    reputation: {
      recordSettlementOutcome: (pubkey, role, outcome, amount) =>
        console.log(`   » reputation: ${role} ${pubkey.slice(0, 16)}… ${outcome} ($${amount})`),
    },
  });

  const req = (syndicateId: string): CommitRequestBody => ({
    syndicate_id: syndicateId,
    sku_canonical: SKU,
    unit_price_usdc: POOLED_PRICE_USDC,
    supplier_wallet: SUPPLIER_WALLET,
    supplier_a2a_url: SUPPLIER_A2A_URL,
    deposit_bps: DEPOSIT_BPS,
    strike_deadline: NOW + 7 * 24 * 3600,
  });

  let committed = 0;
  for (const m of members) {
    const buyer = byPubkey.get(m.buyer_pubkey);
    if (!buyer) continue;
    // §7.2 re-verification: an honest buyer's quote matches the commit; the
    // dishonest-coordinator path returns a swapped wallet, so the buyer refuses.
    const quoteProvider: QuoteProvider = {
      getQuote: async () => ({
        unit_price_usdc: POOLED_PRICE_USDC,
        supplier_wallet: buyer.honest
          ? SUPPLIER_WALLET
          : "0xdead00000000000000000000000000000000dead",
      }),
    };
    try {
      const body = await buildCommitResponse(req(syndicate.id), {
        signer: signerFor(buyer.wallet),
        quoteProvider,
        mandateMaxTotalUsdc: SOLO_PRICE_USDC,
        qty: 1,
        now: NOW,
      });
      settlement.recordCommitment(syndicate.id, m.id, body, NOW);
      committed += 1;
    } catch (err) {
      if (err instanceof ReverificationError) {
        console.log(
          `   » buyer ${m.buyer_pubkey.slice(0, 16)}… DECLINED (re-verify mismatch, §7.2)`,
        );
      } else throw err;
    }
  }

  const strike = await settlement.strike(syndicate.id, NOW);
  return {
    syndicateId: syndicate.id,
    invited: members.length,
    committed,
    settledCount: strike.settledCount,
    strikeOk: strike.ok,
    strikeReason: strike.reason,
    executor,
  };
}

function settledRows(db: DatabaseSync, syndicateId: string) {
  return db
    .prepare(
      `SELECT buyer_pubkey, amount_usdc, tx_hash, supplier_address FROM group_buy_settlements
        WHERE syndicate_id = ? AND leg = 'deposit' AND status = 'settled'`,
    )
    .all(syndicateId) as unknown as Array<{
    buyer_pubkey: string;
    amount_usdc: number;
    tx_hash: string;
    supplier_address: string;
  }>;
}

async function main(): Promise<void> {
  console.log(`\n=== Aubaine Stage-1 harness — SKU: ${SKU_DESCRIPTION} ===`);
  console.log(`    sku_canonical = ${SKU}`);
  console.log(`    solo retail $${SOLO_PRICE_USDC} → pooled $${POOLED_PRICE_USDC} at MOQ ${MOQ}\n`);

  // ── Scenario A: happy path — 6 honest nodes, MOQ 5 ───────────────────────
  console.log(
    "── Scenario A: 6 nodes want it, MOQ 5 (expect: forms at MOQ, 5 settle, 6th rolls to next round) ──",
  );
  {
    const db = openDb();
    const supplier = generateKeyPair();
    const coordinator = generateKeyPair();
    const buyers = makeBuyers(6);
    const r = await runCycle(db, supplier, coordinator, buyers);

    console.log(
      `\n   syndicate ${r.syndicateId.slice(0, 8)}: invited ${r.invited}, committed ${r.committed}, settled ${r.settledCount}, strike ${r.strikeOk ? "OK" : "ABORTED"}`,
    );

    const receipts = settledRows(db, r.syndicateId).map((s) => {
      const env = makeEnvelope(
        "settlement_receipt",
        {
          syndicate_id: r.syndicateId,
          counterparty_pubkey: s.buyer_pubkey,
          role: "buyer",
          amount_usdc: s.amount_usdc,
          outcome: "settled",
          tx_hash: s.tx_hash,
        },
        supplier,
        NOW,
      );
      return { env, verifies: verifyEnvelope(env) };
    });

    const pooledTotal = r.settledCount * POOLED_PRICE_USDC;
    const soloTotal = r.settledCount * SOLO_PRICE_USDC;
    const savings = soloTotal - pooledTotal;
    const feeBps = coordinatorFeeBps(undefined);
    const coordFee = (pooledTotal * feeBps) / 10_000;

    console.log("\n   Economics (the windfall):");
    console.log(
      `     each node:  $${SOLO_PRICE_USDC} solo  →  $${POOLED_PRICE_USDC} pooled   (saves $${SOLO_PRICE_USDC - POOLED_PRICE_USDC})`,
    );
    console.log(
      `     swarm:      $${soloTotal} solo total  →  $${pooledTotal} pooled total   (saves $${savings}, ${Math.round((savings / soloTotal) * 100)}%)`,
    );
    console.log(
      `     coordinator fee @ ${feeBps}bps: $${coordFee.toFixed(2)}  (revenue; not yet captured on-chain — Stage 2)`,
    );
    console.log(
      `     deposit captured now (${DEPOSIT_BPS / 100}%): $${((pooledTotal * DEPOSIT_BPS) / 10_000).toFixed(2)}; balance at service-start.`,
    );
    console.log(
      `\n   Portable receipts: ${receipts.length} signed, ${receipts.filter((x) => x.verifies).length} verify independently.`,
    );

    console.log(
      `\n   (${buyers.length} nodes wanted it; syndicate locked at MOQ ${MOQ}; ${buyers.length - r.invited} rolls to the next round.)`,
    );
    console.log("\n   Invariants:");
    check(
      "syndicate forms at MOQ and strikes",
      r.invited === MOQ && r.strikeOk && r.settledCount === MOQ,
    );
    check(
      "every receipt verifies against its signer (no central DB needed)",
      receipts.length === MOQ && receipts.every((x) => x.verifies),
    );
    const recipients = new Set(r.executor.captures.map((c) => c.to));
    check(
      "coordinator is NEVER the payee — every capture pays supplier_wallet",
      recipients.size === 1 &&
        recipients.has(SUPPLIER_WALLET) &&
        !recipients.has(coordinator.publicKeyHex),
    );
  }

  // ── Scenario B: invariants under stress ──────────────────────────────────
  console.log("\n── Scenario B: 5 nodes, MOQ 5, but a dishonest coordinator swaps one wallet ──");
  console.log(
    "   (expect: re-verify rejects that node → only 4 commit → strike captures NOTHING) ──",
  );
  {
    const db = openDb();
    const supplier = generateKeyPair();
    const coordinator = generateKeyPair();
    const buyers = makeBuyers(5, /* dishonestIndex */ 2);
    const r = await runCycle(db, supplier, coordinator, buyers);

    console.log(
      `\n   syndicate ${r.syndicateId.slice(0, 8)}: invited ${r.invited}, committed ${r.committed}, settled ${r.settledCount}, strike ${r.strikeOk ? "OK" : "ABORTED"} (${r.strikeReason ?? ""})`,
    );
    console.log("\n   Invariants:");
    check("anti-front-running: the mismatched node declined (4 of 5 committed)", r.committed === 4);
    check("confirm-then-capture: under MOQ, the strike aborted", !r.strikeOk);
    check("strand-nobody: ZERO on-chain captures happened", r.executor.captures.length === 0);
    check("no settlement rows reached 'settled'", settledRows(db, r.syndicateId).length === 0);
  }

  console.log(
    `\n=== ${failures === 0 ? "ALL INVARIANTS PASSED" : `${failures} INVARIANT(S) FAILED`} ===\n`,
  );
  if (failures > 0) process.exit(1);
}

await main();
