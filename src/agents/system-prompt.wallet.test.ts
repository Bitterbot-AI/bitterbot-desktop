/**
 * The wallet is a plain CDP server account: x402 payments are gasless, direct
 * sends need ETH for gas. The prompt and the bundled skill must not tell the
 * model that gas is sponsored (issue #399).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const SPONSORED_GAS = /gas sponsored|sponsored gas|zero ETH|no ETH needed|paymaster|smart wallet/i;

describe("wallet wording", () => {
  it("system prompt says sends need ETH and does not claim sponsored gas", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/bitterbot",
      toolNames: ["wallet"],
    });
    const start = prompt.indexOf("## Agent Wallet (USDC on Base)");
    expect(start).toBeGreaterThan(-1);
    const section = prompt.slice(start, prompt.indexOf("\n## ", start + 1));
    expect(section).toContain("send_usdc needs a little ETH");
    expect(section).not.toMatch(SPONSORED_GAS);
  });

  it("wallet-payments skill says the same", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const skill = fs.readFileSync(
      path.resolve(here, "../../skills/wallet-payments/SKILL.md"),
      "utf-8",
    );
    expect(skill).toContain("need a small amount of ETH");
    expect(skill).not.toMatch(SPONSORED_GAS);
  });
});
