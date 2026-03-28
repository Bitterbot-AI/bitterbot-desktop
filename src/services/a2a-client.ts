/**
 * A2A Client — Outbound agent-to-agent task execution.
 *
 * Flow:
 * 1. Discover peer agent (via Agent Card at /.well-known/agent.json)
 * 2. Check if skill is available and get pricing
 * 3. Execute x402 payment via wallet
 * 4. Send task via JSON-RPC message/send
 * 5. Collect result and record purchase
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WalletService } from "./wallet-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("a2a-client");

export interface A2aClientConfig {
  /** Maximum USDC to spend per A2A task. Default: 0.50 */
  maxTaskCostUsdc: number;
  /** Maximum USDC to spend per day on outbound A2A tasks. Default: 2.00.
   *  Without this, LLM retry loops can drain the wallet overnight.
   *  (Gemini peer review: autonomous spend death loop fix) */
  dailySpendLimitUsdc: number;
  /** Request timeout in ms. Default: 60000 (1 minute) */
  taskTimeoutMs: number;
}

export interface PeerAgent {
  url: string;
  name: string;
  description: string;
  skills: Array<{ id: string; name: string; description: string }>;
  paymentRequired: boolean;
  paymentAddress?: string;
  minPayment?: number;
}

export interface A2aTaskResult {
  success: boolean;
  taskId?: string;
  response?: string;
  artifacts?: Array<{ name?: string; content: string }>;
  amountPaid?: number;
  txHash?: string;
  error?: string;
}

export class A2aClient {
  private readonly config: A2aClientConfig;
  private readonly db?: DatabaseSync;

  constructor(config?: Partial<A2aClientConfig>, db?: DatabaseSync) {
    this.config = {
      maxTaskCostUsdc: config?.maxTaskCostUsdc ?? 0.50,
      dailySpendLimitUsdc: config?.dailySpendLimitUsdc ?? 2.00,
      taskTimeoutMs: config?.taskTimeoutMs ?? 60_000,
    };
    this.db = db;
  }

  /**
   * Check if daily outbound spend limit has been reached.
   * MUST be called before every outbound payment.
   * Without it, LLM retry loops can drain the wallet.
   * (Gemini peer review fix)
   */
  checkDailySpendLimit(): { allowed: boolean; spent: number; remaining: number } {
    if (!this.db) return { allowed: true, spent: 0, remaining: this.config.dailySpendLimitUsdc };

    try {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const row = this.db.prepare(`
        SELECT COALESCE(SUM(amount_usdc), 0) as total
        FROM marketplace_purchases
        WHERE direction = 'purchase' AND purchased_at >= ?
      `).get(oneDayAgo) as { total: number };

      const spent = row.total;
      const remaining = this.config.dailySpendLimitUsdc - spent;
      return { allowed: remaining > 0, spent, remaining: Math.max(0, remaining) };
    } catch {
      return { allowed: true, spent: 0, remaining: this.config.dailySpendLimitUsdc };
    }
  }

  /**
   * Discover a peer agent by fetching its Agent Card.
   */
  async discoverAgent(agentUrl: string): Promise<PeerAgent | null> {
    const cardUrl = `${agentUrl.replace(/\/+$/, "")}/.well-known/agent.json`;
    try {
      const response = await fetch(cardUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const card = await response.json() as {
        url: string;
        name: string;
        description: string;
        skills: Array<{ id: string; name: string; description: string }>;
        extensions?: Record<string, unknown>;
      };

      const paymentExt = card.extensions?.["x402-payment"] as {
        address?: string;
        minPayment?: string;
      } | undefined;

      return {
        url: card.url,
        name: card.name,
        description: card.description,
        skills: card.skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
        paymentRequired: !!paymentExt,
        paymentAddress: paymentExt?.address,
        minPayment: paymentExt?.minPayment ? parseFloat(paymentExt.minPayment) : undefined,
      };
    } catch (err) {
      log.debug(`Failed to discover agent at ${agentUrl}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Execute a task on a peer agent, handling payment if required.
   */
  async executeTask(params: {
    agentUrl: string;
    message: string;
    walletService?: WalletService;
  }): Promise<A2aTaskResult> {
    const a2aUrl = `${params.agentUrl.replace(/\/+$/, "")}/a2a`;

    // First attempt — may return 402
    const rpcPayload = {
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: params.message }],
        },
      },
      id: crypto.randomUUID(),
    };

    let response: Response;
    try {
      response = await fetch(a2aUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rpcPayload),
        signal: AbortSignal.timeout(this.config.taskTimeoutMs),
      });
    } catch (err) {
      return { success: false, error: `A2A request failed: ${String(err)}` };
    }

    // Handle 402 — payment required
    if (response.status === 402 && params.walletService) {
      const body = await response.json() as {
        error?: { data?: { payTo?: string; pricing?: { priceUsdc: number } } };
      };

      const payTo = body.error?.data?.payTo;
      const price = body.error?.data?.pricing?.priceUsdc;

      if (!payTo || !price) {
        return { success: false, error: "Payment required but pricing info missing" };
      }

      if (price > this.config.maxTaskCostUsdc) {
        return { success: false, error: `Price $${price} exceeds per-task max $${this.config.maxTaskCostUsdc}` };
      }

      // Check daily spend limit before paying
      const spendCheck = this.checkDailySpendLimit();
      if (!spendCheck.allowed || price > spendCheck.remaining) {
        return {
          success: false,
          error: `Daily A2A spend limit reached ($${spendCheck.spent.toFixed(2)}/$${this.config.dailySpendLimitUsdc.toFixed(2)}). Remaining: $${spendCheck.remaining.toFixed(2)}`,
        };
      }

      // Pay via wallet
      let payment: { txHash: string };
      try {
        payment = await params.walletService.sendUsdc(payTo, price);
      } catch (err) {
        return { success: false, error: `Payment failed: ${String(err)}` };
      }

      // Retry with payment token
      const paymentToken = Buffer.from(JSON.stringify({
        txHash: payment.txHash,
        amount: price,
        sender: await params.walletService.getAddress(),
        timestamp: Date.now(),
      })).toString("base64");

      try {
        response = await fetch(a2aUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Payment-Token": paymentToken,
          },
          body: JSON.stringify({ ...rpcPayload, id: crypto.randomUUID() }),
          signal: AbortSignal.timeout(this.config.taskTimeoutMs),
        });
      } catch (err) {
        return { success: false, error: `A2A request failed after payment: ${String(err)}`, amountPaid: price, txHash: payment.txHash };
      }

      if (!response.ok) {
        return { success: false, error: `A2A request failed after payment: ${response.status}`, amountPaid: price, txHash: payment.txHash };
      }

      const result = await response.json() as { result?: { id?: string; status?: { message?: { parts?: Array<{ text?: string }> } } } };
      return {
        success: true,
        taskId: result.result?.id,
        response: result.result?.status?.message?.parts?.[0]?.text,
        amountPaid: price,
        txHash: payment.txHash,
      };
    }

    if (!response.ok) {
      return { success: false, error: `A2A request failed: ${response.status}` };
    }

    const result = await response.json() as { result?: { id?: string; status?: { message?: { parts?: Array<{ text?: string }> } } } };
    return {
      success: true,
      taskId: result.result?.id,
      response: result.result?.status?.message?.parts?.[0]?.text,
    };
  }
}
