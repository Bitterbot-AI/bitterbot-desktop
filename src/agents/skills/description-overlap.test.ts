import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  descriptionSimilarity,
  findDescriptionOverlap,
  listLiveSkillIndex,
} from "./description-overlap.js";
import { runSkillGate } from "./skill-gate.js";
import { liveSkillPath, resolveStorageRoots } from "./skill-storage.js";

const CURL =
  "Bound every curl in exec with --max-time when the task runs curl; not for commands that make no network calls.";
const CURL_REWORD =
  "Add --max-time to curl in exec whenever a task runs curl; never for commands without network calls.";
const GIT =
  "Explain exit 128 and offer git init when a git command runs outside a repository; not for commands inside a repo.";

describe("descriptionSimilarity / findDescriptionOverlap (PLAN-44 Phase 4b)", () => {
  it("flags a reworded duplicate and clears a different situation", () => {
    expect(descriptionSimilarity(CURL, CURL_REWORD).overlap).toBe(true);
    expect(descriptionSimilarity(CURL, GIT).overlap).toBe(false);
    expect(descriptionSimilarity(CURL, CURL)).toMatchObject({
      tokens: 1,
      containment: 1,
      bigrams: 1,
      overlap: true,
    });
    // Two short descriptions sharing a couple of words are not an overlap.
    expect(descriptionSimilarity("Retry git push", "Retry git pull").overlap).toBe(false);
    expect(descriptionSimilarity("", "")).toMatchObject({ tokens: 0, overlap: false });
  });

  it("returns the closest OTHER live skill, excluding the skill itself", () => {
    const index = [
      { name: "curl-timeout-guard", description: CURL },
      { name: "git-not-a-repo", description: GIT },
      { name: "empty", description: "" },
    ];
    expect(findDescriptionOverlap(CURL_REWORD, index)?.name).toBe("curl-timeout-guard");
    expect(
      findDescriptionOverlap(CURL_REWORD, index, { excludeName: "curl-timeout-guard" }),
    ).toBeNull();
    expect(findDescriptionOverlap(GIT, index, { excludeName: "git-not-a-repo" })).toBeNull();
  });
});

describe("listLiveSkillIndex + gate overlap block", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "desc-overlap-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reads name + description of every live skill", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    for (const [name, desc] of [
      ["curl-timeout-guard", CURL],
      ["git-not-a-repo", GIT],
    ]) {
      await fs.mkdir(path.dirname(liveSkillPath(roots, name!)), { recursive: true });
      await fs.writeFile(
        liveSkillPath(roots, name!),
        `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`,
      );
    }
    expect(await listLiveSkillIndex(roots)).toEqual([
      { name: "curl-timeout-guard", description: CURL },
      { name: "git-not-a-repo", description: GIT },
    ]);
    expect(
      await listLiveSkillIndex(resolveStorageRoots({ configDir: path.join(tmp, "none") })),
    ).toEqual([]);
  });

  it("blocks a synthesized create that overlaps a live description; a patch of that skill is not self-blocked", () => {
    const index = [{ name: "curl-timeout-guard", description: CURL }];
    const dupe = `---\nname: curl-guard-2\ndescription: ${CURL_REWORD}\n---\n# body\nrule\n`;
    const blocked = runSkillGate({
      skillName: "curl-guard-2",
      stagedContent: dupe,
      descriptionContract: true,
      liveIndex: index,
    });
    expect(blocked.outcome).toBe("fail");
    expect(blocked.issues).toEqual([
      expect.objectContaining({ kind: "description-overlap", severity: "block" }),
    ]);
    expect(blocked.issues[0]?.detail).toContain('overlaps live skill "curl-timeout-guard"');
    const self = runSkillGate({
      skillName: "curl-timeout-guard",
      stagedContent: `---\nname: curl-timeout-guard\ndescription: ${CURL_REWORD}\n---\n# body\nrule\n`,
      liveContent: `---\nname: curl-timeout-guard\ndescription: ${CURL}\n---\nold\n`,
      descriptionContract: true,
      liveIndex: index,
    });
    expect(self.outcome).toBe("pass");
    // Human-edited content is not checked.
    expect(
      runSkillGate({ skillName: "curl-guard-2", stagedContent: dupe, liveIndex: index }).outcome,
    ).toBe("pass");
  });
});
