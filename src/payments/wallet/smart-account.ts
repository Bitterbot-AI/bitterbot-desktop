/**
 * CDP Smart Account scaffold — PLAN-48 Phase 4 / PLAN-47 Phase 2.
 *
 * The live upgrade (creating the ERC-4337 CDP Smart Account, routing send_usdc /
 * x402 through it with an on-chain spend permission and sponsored-gas user
 * operations) is an OPERATOR step: it moves real value and needs CDP credentials
 * + a testnet run, so the agent never fires it autonomously. This module is the
 * pure, testable half that the live step builds on:
 *
 *   - `buildSpendPermission` turns the app-side `wallet.smartAccount` allowance
 *     config (the same numbers `SpendPermissionPolicy` enforces off-chain) into
 *     the on-chain spend-permission descriptor to register — one policy
 *     definition on both sides, so the on-chain move is a routing change, not a
 *     re-specification.
 *   - `assertAddressContinuity` is the invariant I5 check: after the upgrade the
 *     smart account must be owned by the original EOA and the EOA's balances must
 *     be intact (a fresh ERC-4337 account is a NEW address owned by the EOA, not
 *     an in-place 7702 upgrade — confirmed in the plan). `doctor-wallet` runs
 *     this against the persisted upgrade record without touching the chain.
 *
 * Neither function performs any network or wallet action.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A CDP spend permission's core economic parameters, ready to register on-chain. */
export interface SpendPermissionDescriptor {
  /** The account the permission constrains (the smart account). */
  account: string;
  /** ERC-20 token the allowance is denominated in (USDC on the network). */
  token: string;
  /** Allowance per period in token base units (USDC has 6 decimals), decimal string. */
  allowance: string;
  /** Period length in seconds. */
  period: number;
  /** Window anchor, unix seconds (fixed periods, matching CDP's recurring model). */
  start: number;
}

/** USDC has 6 decimals; convert a human USD allowance to base units. */
export function usdToBaseUnits(usd: number): string {
  if (!(usd >= 0) || !Number.isFinite(usd)) throw new Error(`invalid allowanceUsd: ${usd}`);
  return BigInt(Math.round(usd * 1_000_000)).toString();
}

/**
 * Build the on-chain spend-permission descriptor from the `wallet.smartAccount`
 * config. `token` is the USDC contract for the network; `startSec` anchors the
 * fixed window (default: now). Pure — registering it on-chain is the operator step.
 */
export function buildSpendPermission(params: {
  smartAccount: string;
  token: string;
  allowanceUsd: number;
  periodSeconds?: number;
  startSec?: number;
}): SpendPermissionDescriptor {
  if (!ADDRESS_RE.test(params.smartAccount)) {
    throw new Error(`smartAccount is not a 0x address: ${params.smartAccount}`);
  }
  if (!ADDRESS_RE.test(params.token)) {
    throw new Error(`token is not a 0x address: ${params.token}`);
  }
  const period = params.periodSeconds ?? 86_400;
  if (!(period > 0)) throw new Error(`invalid periodSeconds: ${period}`);
  return {
    account: params.smartAccount.toLowerCase(),
    token: params.token.toLowerCase(),
    allowance: usdToBaseUnits(params.allowanceUsd),
    period,
    start: params.startSec ?? Math.floor(Date.now() / 1000),
  };
}

/** The persisted record of a completed smart-account upgrade (I5 evidence). */
export interface SmartAccountRecord {
  smartAccountAddress: string;
  /** The EOA that owns the smart account (must equal the original wallet address). */
  ownerAddress: string;
  network: string;
  createdAt: number;
}

export interface ContinuityResult {
  ok: boolean;
  issues: string[];
}

/**
 * Invariant I5 — address & balance continuity after the upgrade. The smart
 * account must be a valid, non-zero address owned by the original EOA, and (when
 * before/after balances are supplied) the EOA's USDC must not have been drained
 * by the upgrade. Pure: callers pass measured values; nothing is read on-chain.
 */
export function assertAddressContinuity(params: {
  eoaAddress: string;
  smartAccountAddress: string;
  smartAccountOwner: string;
  /** EOA USDC balance (base units) before / after the upgrade, if measured. */
  eoaUsdcBefore?: bigint;
  eoaUsdcAfter?: bigint;
}): ContinuityResult {
  const issues: string[] = [];
  if (!ADDRESS_RE.test(params.eoaAddress)) {
    issues.push(`EOA address is not a 0x address: ${params.eoaAddress}`);
  }
  if (!ADDRESS_RE.test(params.smartAccountAddress)) {
    issues.push(`smart account address is not a 0x address: ${params.smartAccountAddress}`);
  } else if (params.smartAccountAddress.toLowerCase() === ZERO_ADDRESS) {
    issues.push("smart account address is the zero address");
  }
  if (params.smartAccountOwner.toLowerCase() !== params.eoaAddress.toLowerCase()) {
    issues.push(
      `smart account owner ${params.smartAccountOwner} != original EOA ${params.eoaAddress}`,
    );
  }
  if (params.eoaUsdcBefore !== undefined && params.eoaUsdcAfter !== undefined) {
    if (params.eoaUsdcAfter < params.eoaUsdcBefore) {
      issues.push(
        `EOA USDC decreased across the upgrade: ${params.eoaUsdcBefore} -> ${params.eoaUsdcAfter}`,
      );
    }
  }
  return { ok: issues.length === 0, issues };
}
