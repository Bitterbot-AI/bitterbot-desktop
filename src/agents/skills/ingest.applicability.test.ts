/**
 * PLAN-58 Phase B, receiver side: a skill that arrives with an applicability
 * profile gets this node's fit computed at ingest, stored beside the
 * envelope, shown in the review list, and carried into the peer stage. A
 * skill without a profile is "unknown", never rejected for it.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BitterbotConfig } from "../../config/config.js";
import type { ReceiverFacts } from "../../memory/skill-evolution/applicability-profile.js";
import { buildProvenanceTrailer } from "../../memory/skill-evolution/provenance-trailer.js";
import type { EvolutionMeta } from "../../memory/skill-evolution/validation-gate.js";
import { CONFIG_DIR } from "../../utils.js";
import {
  acceptIncomingSkill,
  ingestSkill,
  listIncomingSkills,
  receiverFactsFromConfig,
  type SkillEnvelope,
} from "./ingest.js";
import { resolveStorageRoots, stagingSkillDir } from "./skill-storage.js";

function generateEd25519(): { pubkeyBase64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { pubkeyBase64: spki.subarray(-32).toString("base64"), privateKey };
}
function envelopeFor(
  content: string,
  name: string,
  pair: { pubkeyBase64: string; privateKey: KeyObject },
): SkillEnvelope {
  const bytes = Buffer.from(content, "utf-8");
  return {
    version: 1,
    skill_md: bytes.toString("base64"),
    name,
    author_peer_id: "12D3KooWApplicability",
    author_pubkey: pair.pubkeyBase64,
    signature: cryptoSign(null, bytes, pair.privateKey).toString("base64"),
    timestamp: Date.now(),
    content_hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
const RUN_TAG = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const NAME = `fit-skill-${RUN_TAG}`;
const md = (name: string) =>
  `---\nname: ${name}\ndescription: Use when the task asks to ${name} against a flaky host; not for local files.\n---\n\nbody\n`;

const profile = {
  v: 1 as const,
  generatedAt: "2026-10-26T00:00:00.000Z",
  windowDays: 14,
  measured: { models: ["openai/gpt-x"], validatedOn: ["openai/gpt-x"], os: ["linux"] },
  declared: { bins: ["definitely-not-installed-bin"] },
  shape: { tools: [{ name: "exec", runs: 6 }], sequenceHashes: ["abcdef012345"] },
  outcomes: {
    runs: 6,
    pass: 5,
    fail: 1,
    indeterminate: 0,
    successRate: 5 / 6,
    maxEvidenceLevel: 3,
    gate: null,
  },
  failures: [],
};
const meta = {
  origin: "wiki-evolution",
  validation: {
    mode: "tasks",
    verdict: "accepted",
    validatedAt: Date.now(),
    model: "openai/gpt-x",
  },
} as unknown as EvolutionMeta;

describe("PLAN-58: applicability fit on receipt", () => {
  let tmp: string;
  const cfg = (): BitterbotConfig =>
    ({
      skills: { p2p: { ingestPolicy: "review", quarantineDir: path.join(tmp, "skills-incoming") } },
    }) as unknown as BitterbotConfig;
  const facts: ReceiverFacts = {
    platform: "linux",
    model: "openai/gpt-x",
    hasBinary: () => false,
    hasEnv: () => false,
  };
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-fit-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    for (const dir of [
      path.join(CONFIG_DIR, "skills", NAME),
      path.join(CONFIG_DIR, "skills-staging", NAME),
      path.join(CONFIG_DIR, "skills-archive", NAME),
    ]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("computes, stores and lists the fit; a hard mismatch is partial, never a reject; accept carries it to the stage", async () => {
    const node = generateEd25519();
    const body = `${md(NAME).replace(/\n+$/, "")}\n${buildProvenanceTrailer(meta, undefined, { applicability: profile })}`;
    const r = await ingestSkill({
      envelope: envelopeFor(body, NAME, node),
      config: cfg(),
      receiverFacts: facts,
    });
    expect(r.action).toBe("quarantined");
    const env = JSON.parse(
      await fs.readFile(path.join(tmp, "skills-incoming", NAME, ".envelope.json"), "utf-8"),
    ) as { applicability_fit?: { level: string; score: number | null; mismatches: string[] } };
    expect(env.applicability_fit?.level).toBe("partial");
    expect(env.applicability_fit?.mismatches[0]).toContain("definitely-not-installed-bin");

    const listed = (await listIncomingSkills(cfg())).find((s) => s.name === NAME);
    expect(listed?.applicability).toMatchObject({
      level: "partial",
      profile: { models: ["openai/gpt-x"], os: ["linux"], runs: 6, maxEvidenceLevel: 3 },
    });
    expect(listed?.evolutionProvenance?.verdict).toBe("accepted");

    const accepted = await acceptIncomingSkill({ skillName: NAME, config: cfg() });
    expect(accepted.ok).toBe(true);
    const staged = JSON.parse(
      await fs.readFile(
        path.join(stagingSkillDir(resolveStorageRoots(), NAME), ".evolution-meta.json"),
        "utf-8",
      ),
    ) as EvolutionMeta;
    expect(staged.peer?.applicabilityFit?.level).toBe("partial");
    expect(staged.peer?.trailer?.applicability?.outcomes.runs).toBe(6);
  });

  it("a skill with no profile is unknown fit and still quarantines for review", async () => {
    const node = generateEd25519();
    const body = `${md(NAME).replace(/\n+$/, "")}\n${buildProvenanceTrailer(meta)}`;
    const r = await ingestSkill({
      envelope: envelopeFor(body, NAME, node),
      config: cfg(),
      receiverFacts: facts,
    });
    expect(r.action).toBe("quarantined");
    const listed = (await listIncomingSkills(cfg())).find((s) => s.name === NAME);
    expect(listed?.applicability).toEqual({
      level: "unknown",
      score: null,
      mismatches: ["sender shipped no applicability profile"],
    });
    expect(listed?.applicability && "profile" in listed.applicability).toBe(false);
  });

  it("receiverFactsFromConfig reports this platform and probes the real PATH", () => {
    const f = receiverFactsFromConfig({} as BitterbotConfig);
    expect(f.platform).toBe(process.platform);
    expect(f.hasBinary("node")).toBe(true);
    expect(f.hasBinary("definitely-not-installed-bin")).toBe(false);
    expect(f.hasEnv("PATH")).toBe(true);
  });
});
