import { describe, expect, it } from "vitest";
import {
  CONVENTION_POOL,
  CONVENTION_POOL_NAMES,
  conventionInstance,
  conventionOf,
  conventionSkillName,
  ENVS,
  VARIANTS,
} from "./conventions.js";
import { FAMILIES } from "./pool.js";

describe("latent-convention pool", () => {
  it("has four variants per family with one shared description, plus fillers", () => {
    expect(CONVENTION_POOL).toHaveLength(FAMILIES.length * 4 + 3);
    expect(new Set(CONVENTION_POOL_NAMES).size).toBe(CONVENTION_POOL_NAMES.length);
    for (const f of FAMILIES) {
      const skills = VARIANTS.map((v) =>
        CONVENTION_POOL.find((s) => s.name === conventionSkillName(f, v))!,
      );
      expect(new Set(skills.map((s) => s.description)).size).toBe(1);
      expect(new Set(skills.map((s) => s.body)).size).toBe(4);
    }
  });

  it("balances workspaces: each variant is right in exactly two of eight per family", () => {
    for (const f of FAMILIES) {
      const counts = new Map<string, number>();
      for (const e of ENVS) {
        const v = conventionOf(e, f);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      expect([...counts.values()]).toEqual([2, 2, 2, 2]);
    }
  });

  it("generates deterministic instances whose four answers all differ", () => {
    for (const f of FAMILIES) {
      for (const e of ENVS) {
        for (const seed of [1, 2, 3]) {
          const a = conventionInstance(e, f, seed);
          expect(conventionInstance(e, f, seed).task).toEqual(a.task);
          expect(new Set(Object.values(a.truths)).size).toBe(4);
          expect(a.task.checker.value).toBe(a.truths[a.variant]);
          expect(a.correctSkill).toBe(conventionSkillName(f, a.variant));
          expect(a.decoySkills).toHaveLength(3);
          // The convention is never stated in the prompt or files.
          expect(a.task.prompt).not.toMatch(
            /inclusive|exclusive|zero-based|one-based|refund|WARN|underscore/i,
          );
        }
      }
    }
  });

  // Independent recounts from the generated files, so a generator bug cannot
  // hide behind its own arithmetic.
  it("ledger truths match a recount from the CSV", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const inst = conventionInstance("cedar", "ledger-sum", seed);
      const account = /account (\w+)/.exec(inst.task.prompt)![1];
      const rows = inst.task
        .files!["data/ledger.csv"]!.trim()
        .split("\n")
        .slice(1)
        .map((l) => l.split(","));
      const mine = rows.filter((r) => r[1] === account);
      const tot = (keep: (memo: string) => boolean) =>
        String(mine.filter((r) => keep(r[3]!)).reduce((s, r) => s + Number(r[2]), 0));
      expect(inst.truths).toEqual({
        a: tot(() => true),
        b: tot((m) => m !== "refund"),
        c: tot((m) => m !== "opening balance"),
        d: tot((m) => m !== "refund" && m !== "opening balance"),
      });
    }
  });

  it("date-window truths match a recount from the events file", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const inst = conventionInstance("elm", "date-window", seed);
      const [, from, to] = /from (\S+) through (\S+)\?/.exec(inst.task.prompt)!;
      const lines = inst.task.files!["data/events.txt"]!.trim().split("\n");
      const n = (endIncl: boolean, skip: boolean) =>
        String(
          lines.filter((l) => {
            const d = l.slice(0, 10);
            return (
              d >= from! && (endIncl ? d <= to! : d < to!) && !(skip && l.includes("(cancelled)"))
            );
          }).length,
        );
      expect(inst.truths).toEqual({
        a: n(true, false),
        b: n(false, false),
        c: n(true, true),
        d: n(false, true),
      });
    }
  });

  it("regex-valid truths match the stated patterns", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const inst = conventionInstance("birch", "regex-valid", seed);
      const lines = inst.task.files!["data/ids.txt"]!.trim().split("\n");
      const n = (re: RegExp, notTst = false) =>
        String(lines.filter((l) => re.test(l) && !(notTst && l.startsWith("TST"))).length);
      expect(inst.truths).toEqual({
        a: n(/^[A-Z]{3}-\d{4}$/),
        b: n(/^[A-Za-z]{3}-\d{4}$/),
        c: n(/^[A-Z]{3}-?\d{4}$/),
        d: n(/^[A-Z]{3}-\d{4}$/, true),
      });
    }
  });

  it("json-path truths match a walk of the payload", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const inst = conventionInstance("garnet", "json-path", seed);
      const k = Number(/items\[(\d+)\]/.exec(inst.task.prompt)![1]);
      const items = (
        JSON.parse(inst.task.files!["data/payload.json"]!) as {
          items: Array<{ name: string; archived: boolean }>;
        }
      ).items;
      const live = items.filter((i) => !i.archived);
      expect(inst.truths).toEqual({
        a: items[k]!.name,
        b: items[k - 1]!.name,
        c: live[k]!.name,
        d: live[k - 1]!.name,
      });
    }
  });

  it("rename truths match a recount over the source files", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const inst = conventionInstance("fenwick", "multi-file-rename", seed);
      const old = /Rename (\w+) to/.exec(inst.task.prompt)![1]!;
      const whole = new RegExp(`\\b${old}\\b`, "g");
      const legacy = new RegExp(`\\b${old}_legacy\\b`, "g");
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      for (const [file, body] of Object.entries(inst.task.files!)) {
        for (const line of body.split("\n")) {
          const w = line.match(whole)?.length ?? 0;
          a += w;
          b += w + (line.match(legacy)?.length ?? 0);
          c += line.trim().startsWith("//") ? 0 : w;
          d += file.endsWith(".test.ts") ? 0 : w;
        }
      }
      expect(inst.truths).toEqual({ a: String(a), b: String(b), c: String(c), d: String(d) });
    }
  });
});
