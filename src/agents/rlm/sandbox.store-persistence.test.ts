/**
 * The sandbox's durable store must round-trip: store() -> exportStore() ->
 * disk -> importStore() -> get().
 *
 * Context (2026-08-13): a continuity probe stored `violet-owl-42` and a later
 * call could not find it, which read like a broken memory. It was not — the
 * persistence chain below is intact, and deep-recall-tool.ts awaits
 * persistStore(exportStore()) after EVERY run including capped ones. The marker
 * was never stored in the first place: the run burned its 16 iterations and
 * returned a scrap that claimed otherwise. These tests pin the mechanism so a
 * future "the marker vanished" report can be triaged as executor vs storage
 * without another live archaeology session.
 */
import { describe, expect, it } from "vitest";
import { RLMSandbox } from "./sandbox.js";

function sandbox(): RLMSandbox {
  return new RLMSandbox("context text");
}

describe("RLM sandbox durable store", () => {
  it("exports what store() wrote", async () => {
    const sb = sandbox();
    await sb.execute(`store("probe_token_a", "amber-heron-77"); store("count", 3);`);
    expect(sb.exportStore()).toMatchObject({ probe_token_a: "amber-heron-77", count: 3 });
    sb.dispose();
  });

  it("survives a fresh sandbox via export/import, the way a restart does", async () => {
    const first = sandbox();
    await first.execute(`store("probe_token_a", "amber-heron-77");`);
    const onDisk = JSON.parse(JSON.stringify(first.exportStore())) as Record<string, unknown>;
    first.dispose();

    const second = sandbox();
    second.importStore(onDisk);
    await second.execute(`FINAL(String(get("probe_token_a")));`);
    expect(second.getFinalAnswer()).toBe("amber-heron-77");
    expect(second.exportStore().probe_token_a).toBe("amber-heron-77");
    second.dispose();
  });

  it("keeps live values when importing an older snapshot (existing keys win)", async () => {
    const sb = sandbox();
    await sb.execute(`store("probe_token_a", "newer");`);
    sb.importStore({ probe_token_a: "older", other: "kept" });
    expect(sb.exportStore()).toMatchObject({ probe_token_a: "newer", other: "kept" });
    sb.dispose();
  });

  it("drops non-serializable values instead of poisoning the whole store", async () => {
    const sb = sandbox();
    await sb.execute(`store("ok", "fine"); const c = {}; c.self = c; store("cyclic", c);`);
    const exported = sb.exportStore();
    expect(exported.ok).toBe("fine");
    expect("cyclic" in exported).toBe(false);
    sb.dispose();
  });
});
