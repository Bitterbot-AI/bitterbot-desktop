import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rejectIncomingSkillsByPeer = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }));

vi.mock("../agents/skills/ingest.js", () => ({ rejectIncomingSkillsByPeer }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../config/config.js", () => ({ loadConfig: () => ({ skills: {} }) }));

import { registerSkillsCli } from "./skills-cli.js";

async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerSkillsCli(program);
  await program.parseAsync(["node", "bitterbot", "skills", "incoming", "reject-peer", ...args]);
}

describe("bitterbot skills incoming reject-peer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects every quarantined skill from the peer", async () => {
    rejectIncomingSkillsByPeer.mockResolvedValue({ ok: true, rejected: ["a", "b"], errored: [] });
    await run("12D3KooWSpammer");
    expect(rejectIncomingSkillsByPeer).toHaveBeenCalledWith({
      authorPeerId: "12D3KooWSpammer",
      config: { skills: {} },
    });
    expect(runtime.log).toHaveBeenCalledWith("rejected 2 skill(s) from 12D3KooWSpammer");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("says so when nothing is held from that peer", async () => {
    rejectIncomingSkillsByPeer.mockResolvedValue({ ok: true, rejected: [], errored: [] });
    await run("12D3KooWQuiet");
    expect(runtime.log).toHaveBeenCalledWith("no quarantined skills from 12D3KooWQuiet");
  });

  it("reports partial failures and exits non-zero", async () => {
    rejectIncomingSkillsByPeer.mockResolvedValue({
      ok: false,
      rejected: ["a"],
      errored: [{ name: "b", reason: "EACCES" }],
    });
    await run("12D3KooWMixed");
    expect(runtime.error).toHaveBeenCalledWith("  b: EACCES");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
