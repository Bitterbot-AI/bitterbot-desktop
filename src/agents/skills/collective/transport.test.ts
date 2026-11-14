import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../../../commerce/envelope.js";
import { learningHash, lineageId, PACKAGE_LIMITS } from "./contracts.js";
import { snapshotPackage } from "./package.js";
import { SkillPolicyService } from "./policy.js";
import { signRelease } from "./signatures.js";
import { CollectiveSkillStore } from "./store.js";
import {
  createWithdrawal,
  PackageDistribution,
  receivePackage,
  withdrawRelease,
  type PackageTransport,
} from "./transport.js";

const roots: string[] = [],
  dbs: DatabaseSync[] = [];
afterEach(async () => {
  dbs.splice(0).forEach((db) => db.close());
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-transport-"));
  roots.push(root);
  const make = (name: string) => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    return new CollectiveSkillStore(db, path.join(root, name));
  };
  const author = make("author"),
    recipient = make("recipient");
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: research-brief\ndescription: Write research briefs with verified source facts and dates.\n---\nRead the provided sources and the template. Preserve citations, disagreements and uncertainties. Record a recommendation and follow-up owner.\n",
  );
  await fs.writeFile(path.join(source, "template.txt"), "bounded fixture ".repeat(6000));
  const snapshot = await snapshotPackage(source, {
    name: "research-brief",
    description: "Source-backed briefs",
    requirements: { platforms: [], tools: {}, runtime: {}, capabilities: [] },
  });
  await author.install(snapshot);
  await author.screen(snapshot.packageHash);
  author.state(snapshot.packageHash, "stable", null, "env");
  const key = generateKeyPair(),
    publisher = `ed25519:${key.publicKeyHex}`;
  const members = new Set([publisher, "recipient"]);
  const policies = new SkillPolicyService(
    author,
    (circle, peer) => circle === "circle-a" && members.has(peer),
  );
  const release = signRelease(
    {
      protocol: "bitterbot/skill-release/1",
      publisher,
      skillId: "brief",
      version: 1,
      previousRelease: null,
      parents: [],
      packageHash: snapshot.packageHash,
      scope: { kind: "circle", circleId: "circle-a" },
      issuedAt: Date.now(),
    },
    key,
  );
  const policy = {
    id: "trusted-circle",
    scope: release.scope,
    enabled: true,
    agents: ["main"],
    publishers: [publisher],
    skillIds: ["brief"],
    operations: ["publish"],
    categories: ["skill-package"],
    capabilities: [],
    budget: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
    expiresAt: Date.now() + 600000,
  };
  policies.set(policy);
  const distribution = new PackageDistribution(author, policies);
  const transport: PackageTransport = {
    announce: async () => {},
    fetch: async (r) => distribution.serve(r, "recipient", "circle-a"),
  };
  return {
    root,
    source,
    author,
    recipient,
    policies,
    policy,
    members,
    key,
    publisher,
    release,
    distribution,
    transport,
    snapshot,
  };
}

describe("complete package transport", () => {
  it("resumes an interrupted download from a verified chunk and installs every file", async () => {
    const f = await setup();
    const id = await f.distribution.publish("main", f.release, f.transport);
    const requested: number[] = [];
    let calls = 0;
    await expect(
      receivePackage(
        f.recipient,
        f.release,
        {
          ...f.transport,
          fetch: async (r, s) => {
            if (++calls === 4) throw new Error("lost connection");
            return f.transport.fetch(r, s);
          },
        },
        () => {},
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("lost connection");
    expect(f.recipient.get(f.snapshot.packageHash)).toBeNull();
    expect(
      await receivePackage(
        f.recipient,
        f.release,
        {
          ...f.transport,
          fetch: async (r, s) => {
            requested.push(r.offset);
            return f.transport.fetch(r, s);
          },
        },
        () => {},
        AbortSignal.timeout(5000),
      ),
    ).toBe(id);
    expect(requested[0]).toBe(PACKAGE_LIMITS.chunk);
    const received = await f.recipient.read(f.snapshot.packageHash);
    for (const [name, bytes] of f.snapshot.files)
      expect(received.files.get(name)?.equals(bytes)).toBe(true);
    expect(f.recipient.get(received.packageHash)?.state).toBe("candidate");
  });
  it("enforces membership and separate object-serving scopes on every request", async () => {
    const f = await setup();
    const id = await f.distribution.publish("main", f.release, f.transport);
    const request = { releaseId: id, objectHash: f.snapshot.packageHash, offset: 0 };
    await expect(f.distribution.serve(request, "outsider", "circle-a")).rejects.toThrow("denied");
    await expect(f.distribution.serve(request, "recipient")).rejects.toThrow("denied");
    await expect(f.distribution.serve(request, "recipient", "circle-b")).rejects.toThrow("denied");
    f.members.delete("recipient");
    await expect(f.distribution.serve(request, "recipient", "circle-a")).rejects.toThrow("denied");
    f.members.add("recipient");
    f.policies.revoke(f.policy.id);
    await expect(f.distribution.serve(request, "recipient", "circle-a")).rejects.toThrow(
      "Approval",
    );
  });
  it("reconciles a lost announcement response using the same immutable release", async () => {
    const f = await setup();
    const seen: string[] = [];
    await expect(
      f.distribution.publish("main", f.release, {
        ...f.transport,
        announce: async (_, id) => {
          seen.push(id);
          throw new Error("response lost");
        },
      }),
    ).rejects.toThrow();
    await f.distribution.publish("main", f.release, {
      ...f.transport,
      announce: async (_, id) => {
        seen.push(id);
      },
    });
    expect(seen[0]).toBe(seen[1]);
    expect(f.author.db.prepare("SELECT COUNT(*) AS n FROM collective_releases").get()?.n).toBe(1);
    await f.distribution.publish("main", f.release, {
      ...f.transport,
      announce: async () => {
        throw new Error("duplicate send");
      },
    });
  });
  it("rejects tampering, changed authority, and stale hash-bound exceptions", async () => {
    const f = await setup();
    await f.distribution.publish("main", f.release, f.transport);
    await expect(
      receivePackage(
        f.recipient,
        f.release,
        {
          ...f.transport,
          fetch: async (r, s) => ({
            ...(await f.transport.fetch(r, s)),
            data: Buffer.from("forged").toString("base64"),
          }),
        },
        () => {},
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
    let checks = 0;
    await expect(
      receivePackage(
        f.recipient,
        f.release,
        f.transport,
        () => {
          if (++checks > 3) throw new Error("grant revoked");
        },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("revoked");
    f.policies.set({ ...f.policy, packageHashes: ["f".repeat(64)] });
    expect(() => f.policies.authorize("main", f.release, "publish", "skill-package")).toThrow(
      "Approval",
    );
  });
  it("does not let another publisher withdraw an adopted lineage", async () => {
    const f = await setup();
    const id = await f.distribution.publish("main", f.release, f.transport);
    f.author.activate("main", f.release, "env");
    const attacker = generateKeyPair();
    expect(() => withdrawRelease(f.author, createWithdrawal(id, attacker))).toThrow("authorized");
    const fork = signRelease(
      { ...f.release, publisher: `ed25519:${attacker.publicKeyHex}`, skillId: "attacker-copy" },
      attacker,
    );
    const forkId = f.author.addRelease(fork);
    withdrawRelease(f.author, createWithdrawal(forkId, attacker));
    expect(f.author.active("main", lineageId(f.release))?.hash).toBe(f.release.packageHash);
    expect(f.author.get(f.release.packageHash)?.state).toBe("canary");
    withdrawRelease(f.author, createWithdrawal(id, f.key));
    expect(f.author.active("main", lineageId(f.release))).toBeNull();
    withdrawRelease(f.author, createWithdrawal(id, f.key)); // Idempotent after a lost response.
  });
  it("blocks private Circle descendants from public publishing despite a public grant", async () => {
    const f = await setup();
    f.author.recordOrigin(f.snapshot.packageHash, f.release.scope);
    const publicRelease = signRelease({ ...f.release, scope: { kind: "public" } }, f.key);
    f.policies.set({ ...f.policy, id: "public", scope: { kind: "public" } });
    await expect(f.distribution.publish("main", publicRelease, f.transport)).rejects.toThrow(
      "disclosure",
    );
    f.author.inheritOrigins("a".repeat(64), f.snapshot.packageHash);
    expect(() =>
      f.author.assertDisclosure("a".repeat(64), { kind: "circle", circleId: "other" }),
    ).toThrow("disclosure");
    expect(() => f.author.assertDisclosure("a".repeat(64), f.release.scope)).not.toThrow();
  });
  it("rejects forged signatures and equivocated versions", async () => {
    const f = await setup();
    f.author.addRelease(f.release);
    expect(() => f.author.addRelease({ ...f.release, packageHash: "0".repeat(64) })).toThrow(
      "signature",
    );
    const equivocation = signRelease({ ...f.release, packageHash: "0".repeat(64) }, f.key);
    expect(() => f.author.addRelease(equivocation)).toThrow("equivocation");
    expect(learningHash(f.release)).toHaveLength(64);
  });
});
