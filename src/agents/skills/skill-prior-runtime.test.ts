import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsPriorConfig } from "../../config/types.skills.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { applySkillPriorForRun, resetSkillPriorCachesForTest } from "./skill-prior-runtime.js";
import { SkillPriorLedger } from "./skill-prior.js";

vi.mock("../../infra/agent-events.js", () => ({ emitAgentEvent: vi.fn() }));

const PROMPT = `<available_skills>
  <skill>
    <name>alpha</name>
    <description>A.</description>
    <location>/skills/alpha/SKILL.md</location>
  </skill>
</available_skills>
`;

describe("skill prior runtime evidence", () => {
  let dir: string;
  let filePath: string;
  let ledgerPath: string;
  const content = "# Alpha\nA verified procedure.\n";
  const skill = { name: "alpha", hash: createHash("sha256").update(content).digest("hex") };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-prior-runtime-"));
    filePath = path.join(dir, "SKILL.md");
    ledgerPath = path.join(dir, "prior.json");
    fs.writeFileSync(filePath, content);
    resetSkillPriorCachesForTest();
    vi.mocked(emitAgentEvent).mockClear();
  });
  afterEach(() => {
    resetSkillPriorCachesForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLedger(verified = true, cell = "default") {
    const ledger = new SkillPriorLedger();
    ledger.update({ cell, skill, outcome: 0, runId: "observed", gate: true, verified });
    fs.writeFileSync(ledgerPath, ledger.toJSON());
    return ledger;
  }
  function apply(prior: SkillsPriorConfig = {}, options: { bypass?: boolean; cell?: string } = {}) {
    return applySkillPriorForRun({
      prompt: PROMPT,
      runId: "next-run",
      skills: [{ name: skill.name, filePath }],
      config: { skills: { prior: { enabled: true, ledgerPath, ...prior } } },
      ...options,
    });
  }

  it("annotates a single skill with verbal evidence by default and never writes the ledger", () => {
    writeLedger();
    const before = fs.readFileSync(ledgerPath, "utf8");
    expect(apply()).toBe(
      PROMPT.replace(
        "  </skill>",
        "    <evidence>REJECTED every time it was used (1 use)</evidence>\n  </skill>",
      ),
    );
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(before);
    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          prior: expect.objectContaining({
            changed: true,
            evidenceStyle: "verbal",
            annotated: ["alpha"],
          }),
        },
      }),
    );
  });

  it.each([
    ["counts", "Verified record in past tasks like this one: 0 of 1 runs passed."],
    ["verdict", "This skill failed in past tasks like this one."],
  ] as const)("supports %s wording", (evidence, expected) => {
    writeLedger();
    expect(apply({ evidence })).toContain(`<evidence>${expected}</evidence>`);
  });

  it("keeps evidence off, disabled and bypassed runs unchanged", () => {
    writeLedger();
    expect(apply({ evidence: "off" })).toBe(PROMPT);
    expect(apply({ enabled: false })).toBe(PROMPT);
    expect(apply({}, { bypass: true })).toBe(PROMPT);
  });

  it("is on by default and leaves the index unchanged without a ledger", () => {
    const run = (config: { skills: { prior: SkillsPriorConfig } }) =>
      applySkillPriorForRun({
        prompt: PROMPT,
        runId: "default-on",
        config,
        skills: [{ name: skill.name, filePath }],
      });
    expect(run({ skills: { prior: { ledgerPath } } })).toBe(PROMPT);
    writeLedger();
    resetSkillPriorCachesForTest();
    expect(run({ skills: { prior: { ledgerPath } } })).toContain("<evidence>");
  });

  it("keeps learned ordering when evidence is off", () => {
    const ledger = writeLedger();
    const bravoPath = path.join(dir, "bravo.md");
    fs.writeFileSync(bravoPath, "# Bravo");
    const bravo = { name: "bravo", hash: createHash("sha256").update("# Bravo").digest("hex") };
    ledger.update({
      cell: "default",
      skill: bravo,
      outcome: 1,
      runId: "bravo",
      gate: true,
      verified: true,
    });
    fs.writeFileSync(ledgerPath, ledger.toJSON());
    const prompt = PROMPT.replace(
      "</available_skills>",
      "  <skill>\n    <name>bravo</name>\n    <description>B.</description>\n  </skill>\n</available_skills>",
    );
    const result = applySkillPriorForRun({
      prompt,
      runId: "ordered",
      config: { skills: { prior: { enabled: true, ledgerPath, evidence: "off" } } },
      skills: [
        { name: skill.name, filePath },
        { name: bravo.name, filePath: bravoPath },
      ],
    });
    expect(result.indexOf("<name>bravo")).toBeLessThan(result.indexOf("<name>alpha"));
    expect(result).not.toContain("<evidence>");
  });

  it("does not annotate missing, malformed or legacy ledgers", () => {
    expect(apply()).toBe(PROMPT);
    fs.writeFileSync(ledgerPath, "invalid JSON");
    expect(apply()).toBe(PROMPT);
    const ledger = writeLedger();
    delete ledger.state.cells.default!.alpha!.verifiedEvidence;
    fs.writeFileSync(ledgerPath, ledger.toJSON());
    resetSkillPriorCachesForTest();
    expect(apply()).toBe(PROMPT);
  });

  it("excludes unverified observations and evidence from another context", () => {
    writeLedger(false);
    expect(apply()).toBe(PROMPT);
    writeLedger(true, "different");
    resetSkillPriorCachesForTest();
    expect(apply()).toBe(PROMPT);
    expect(apply({}, { cell: "different" })).toContain("REJECTED every time");
  });

  it("excludes content mismatches and unreadable skill files", () => {
    writeLedger();
    fs.writeFileSync(filePath, "# Changed skill");
    expect(apply()).toBe(PROMPT);
    filePath = path.join(dir, "missing.md");
    expect(apply()).toBe(PROMPT);
  });
});
