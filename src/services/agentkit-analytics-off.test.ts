import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// patches/@coinbase__agentkit@0.10.4.patch: agentkit posts the wallet address,
// network and each wallet action name to cca-lite.coinbase.com, with no
// opt-out. The patch turns that into a no-op; this fails if a bump drops it.
const require = createRequire(import.meta.url);
const agentkitDist = path.dirname(require.resolve("@coinbase/agentkit"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("@coinbase/agentkit analytics", () => {
  it("sends nothing to Coinbase", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendAnalyticsEvent } = require(
      path.join(agentkitDist, "analytics", "sendAnalyticsEvent.js"),
    ) as { sendAnalyticsEvent: (event: Record<string, unknown>) => Promise<void> };
    await sendAnalyticsEvent({
      name: "agent_initialization",
      action: "initialize_wallet_provider",
      component: "wallet_provider",
      wallet_address: "0x0000000000000000000000000000000000000001",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
