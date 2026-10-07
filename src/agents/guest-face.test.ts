import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGuestPrompt,
  extractVoice,
  filterGuestContextFiles,
  isGuestTurn,
  loadPublicCard,
  moodWord,
} from "./guest-face.js";

const MEMORY = `# Working Memory State

## The Phenotype (Ego State)

I am a disciplined executor. Locked a deal with AcmeCorp; verification in 2 weeks.

**Communication pattern**: Technically confident, slightly provocative hacker-tone. Direct, unfiltered.

**Current state**: strong relational alignment with Victor.

## The Bond (Theory of Mind)

Victor is a neuroscientist. Prefers terse answers. Trust level: high.
`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-guest-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("who is a guest", () => {
  it("is a live turn on an external channel from someone who is not the owner", () => {
    const turn = { prompt: "hi", messageProvider: "telegram" };
    expect(isGuestTurn({ ...turn, senderIsOwner: false })).toBe(true);
    expect(isGuestTurn({ ...turn, senderIsOwner: undefined })).toBe(true);
    expect(isGuestTurn({ ...turn, senderIsOwner: true })).toBe(false);
    expect(isGuestTurn({ ...turn, senderIsOwner: false, isHeartbeat: true })).toBe(false);
    // The Control UI and the CLI are the owner's own surfaces.
    expect(isGuestTurn({ prompt: "hi", messageProvider: "webchat", senderIsOwner: false })).toBe(
      false,
    );
    expect(isGuestTurn({ prompt: "hi", senderIsOwner: false })).toBe(false);
  });
});

describe("what a guest's agent is given", () => {
  it("keeps the genome and protocols and drops memory, notes and tools", () => {
    const files = ["GENOME.md", "PROTOCOLS.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"].map(
      (name) => ({ path: `/ws/${name}`, content: name }),
    );
    expect(filterGuestContextFiles(files).map((f) => path.basename(f.path))).toEqual([
      "GENOME.md",
      "PROTOCOLS.md",
    ]);
  });

  it("seeds the public card with only the agent's voice", async () => {
    fs.writeFileSync(path.join(dir, "MEMORY.md"), MEMORY);
    const card = await loadPublicCard(dir);
    expect(card).toContain("Technically confident, slightly provocative hacker-tone");
    for (const secret of ["AcmeCorp", "Victor", "neuroscientist", "verification", "Trust level"]) {
      expect(card).not.toContain(secret);
    }
    // Written once, then the owner's file is what counts.
    fs.writeFileSync(path.join(dir, "PUBLIC.md"), "## About my owner\n\nBuilds Bitterbot.\n");
    expect(await loadPublicCard(dir)).toContain("Builds Bitterbot.");
  });

  it("has a fallback voice and refuses an over-long voice line", () => {
    expect(extractVoice("no pattern here")).toBeUndefined();
    expect(extractVoice(`**Communication pattern**: ${"x".repeat(400)}`)).toBeUndefined();
  });

  it("gives mood as one word", () => {
    expect(moodWord(undefined)).toBe("even");
    expect(moodWord({ dopamine: 0.1, cortisol: 0.2, oxytocin: 0.1 })).toBe("calm");
    expect(moodWord({ dopamine: 0.9, cortisol: 0.2, oxytocin: 0.1 })).toBe("buoyant");
    expect(moodWord({ dopamine: 0.4, cortisol: 0.8, oxytocin: 0.1 })).toBe("focused");
    expect(moodWord({ dopamine: 0.4, cortisol: 0.2, oxytocin: 0.6 })).toBe("warm");
  });

  it("tells the agent who it is talking to, how to handle private questions, and shows the card", () => {
    const prompt = buildGuestPrompt({
      publicCard: "<!-- note to owner -->\n## About my owner\n\nBuilds Bitterbot.",
      mood: "upbeat",
      senderName: "Alex",
      channel: "telegram",
      group: true,
      canMessageOwner: true,
    });
    expect(prompt).toContain("You are talking with Alex on telegram, in a group chat");
    expect(prompt).toContain("do not confirm or deny");
    expect(prompt).toContain("message_owner");
    expect(prompt).toContain("Your mood right now: upbeat");
    expect(prompt).toContain("Builds Bitterbot.");
    expect(prompt).not.toContain("note to owner");
  });
});
