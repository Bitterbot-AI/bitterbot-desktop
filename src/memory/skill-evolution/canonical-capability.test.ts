/**
 * PLAN-45 Phase 2.1: the canonical capability families. Ground truth is
 * re-derived from the generated FILES (the way the agent has to), never
 * from the generator's internals.
 */

import { describe, expect, it } from "vitest";
import { MAX_TASK_FILE_BYTES, MAX_TASK_FILES, taskFileBytes } from "./canonical-capability.js";
import { generateCanonicalCorpus } from "./canonical-corpus.js";
import { parseCorpusTasks, parseTaskFiles, scoreTaskAnswer } from "./task-corpus.js";

const byId = (seed: number) =>
  new Map(generateCanonicalCorpus(seed).tasks.map((t) => [t.id, t] as const));

describe("canonical capability families", () => {
  it("ground truth is correct across a seed sweep (recomputed from the files)", () => {
    for (let seed = 0; seed < 20; seed++) {
      const tasks = byId(seed);

      const ledger = tasks.get("cap-ledger-sum")!;
      const account = /account "([a-z]+)"/.exec(ledger.prompt)![1]!;
      const total = ledger
        .files!["data/ledger.csv"]!.split("\n")
        .slice(1)
        .filter((l) => l.trim())
        .map((l) => l.split(","))
        .filter((c) => c[1] === account)
        .reduce((a, c) => a + Number(c[2]), 0);
      expect(ledger.checker.value, `seed ${seed} ledger`).toBe(String(total));

      const triage = tasks.get("cap-log-triage")!;
      const counts = new Map<string, number>();
      for (const line of triage.files!["logs/app.log"]!.split("\n")) {
        const m = /^\S+ ERROR (\w+):/.exec(line);
        if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
      }
      const top = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
      expect(top[0]![1]).toBeGreaterThan(top[1]?.[1] ?? -1); // unique maximum
      expect(triage.checker.value, `seed ${seed} triage`).toBe(`${top[0]![0]}:${top[0]![1]}`);

      const diff = tasks.get("cap-config-diff")!;
      const base = JSON.parse(diff.files!["config/base.json"]!) as Record<string, number>;
      const prod = JSON.parse(diff.files!["config/prod.json"]!) as Record<string, number>;
      const differing = Object.keys(base)
        .filter((k) => base[k] !== prod[k])
        .toSorted();
      expect(diff.checker.value, `seed ${seed} diff`).toBe(differing.join(","));

      const dep = tasks.get("cap-dep-depth")!;
      const root = /"([a-z]+)" depend/.exec(dep.prompt)![1]!;
      const deps = JSON.parse(dep.files!["deps.json"]!) as Record<string, string[]>;
      const seen = new Set<string>();
      const walk = (p: string) => {
        for (const d of deps[p] ?? []) {
          if (!seen.has(d)) {
            seen.add(d);
            walk(d);
          }
        }
      };
      walk(root);
      expect(dep.checker.value, `seed ${seed} dep`).toBe(String(seen.size));

      const ids = tasks.get("cap-regex-valid")!;
      const valid = ids
        .files!["data/ids.txt"]!.split("\n")
        .filter((l) => /^[A-Z]{3}-\d{4}$/.test(l)).length;
      expect(ids.checker.value, `seed ${seed} ids`).toBe(String(valid));

      const rename = tasks.get("cap-multi-file-rename")!;
      const oldName = /identifier (\w+) to/.exec(rename.prompt)![1]!;
      let occurrences = 0;
      for (const content of Object.values(rename.files!)) {
        occurrences += (content.match(new RegExp(`\\b${oldName}\\b(?!_legacy)`, "g")) ?? []).length;
      }
      expect(rename.checker.value, `seed ${seed} rename`).toBe(String(occurrences));

      const orders = tasks.get("cap-csv-filter-sum")!;
      const region = /region is "([a-z]+)"/.exec(orders.prompt)![1]!;
      const sum = orders
        .files!["data/orders.csv"]!.split("\n")
        .slice(1)
        .filter((l) => l.trim())
        .map((l) => l.split(","))
        .filter((c) => c[1] === region && c[2] === "shipped")
        .reduce((a, c) => a + Number(c[3]), 0);
      expect(orders.checker.value, `seed ${seed} orders`).toBe(String(sum));

      const jp = tasks.get("cap-json-path")!;
      const idx = Number(/items\[(\d+)\]/.exec(jp.prompt)![1]);
      const payload = JSON.parse(jp.files!["data/payload.json"]!) as {
        batch: { items: Array<{ meta: { score: number } }> };
      };
      expect(jp.checker.value, `seed ${seed} json`).toBe(
        String(payload.batch.items[idx]!.meta.score),
      );

      const win = tasks.get("cap-date-window")!;
      const [, start, end] = /2026-09-(\d\d) through 2026-09-(\d\d)/.exec(win.prompt)!;
      const inside = win.files!["data/events.txt"]!.split("\n").filter((l) => {
        const m = /^2026-(\d\d)-(\d\d) /.exec(l);
        return m && m[1] === "09" && Number(m[2]) >= Number(start) && Number(m[2]) <= Number(end);
      }).length;
      expect(win.checker.value, `seed ${seed} window`).toBe(String(inside));

      // The hardened checker: FINAL line scores 1, bare value scores 0.
      expect(scoreTaskAnswer(ledger, `FINAL: ${ledger.checker.value}`)).toBe(1);
      expect(scoreTaskAnswer(ledger, ledger.checker.value)).toBe(0);
    }
  });

  it("files stay within the caps and survive a JSONL round trip", () => {
    for (const task of generateCanonicalCorpus(7).tasks.filter((t) => t.suite === "capability")) {
      expect(Object.keys(task.files!).length).toBeLessThanOrEqual(MAX_TASK_FILES);
      expect(taskFileBytes(task)).toBeLessThanOrEqual(MAX_TASK_FILE_BYTES);
      const [parsed] = parseCorpusTasks(`${JSON.stringify(task)}\n`);
      expect(parsed?.files).toEqual(task.files);
      expect(parsed?.suite).toBe("capability");
    }
  });

  it("parseTaskFiles refuses traversal, absolute paths, and oversize payloads", () => {
    expect(parseTaskFiles({ "../x": "a" })).toBeNull();
    expect(parseTaskFiles({ "/etc/passwd": "a" })).toBeNull();
    expect(parseTaskFiles({ "a/../../b": "a" })).toBeNull();
    expect(parseTaskFiles({ "C:/x": "a" })).toBeNull();
    expect(parseTaskFiles({ "ok/file.txt": "x".repeat(MAX_TASK_FILE_BYTES + 1) })).toBeNull();
    expect(parseTaskFiles({ "ok/file.txt": "fine", "sub/dir/f": "" })).toEqual({
      "ok/file.txt": "fine",
      "sub/dir/f": "",
    });
    expect(parseTaskFiles("nope")).toBeNull();
  });

  it("instances differ across seeds and are identical for one seed", () => {
    const a = byId(1).get("cap-ledger-sum")!;
    const b = byId(2).get("cap-ledger-sum")!;
    const a2 = byId(1).get("cap-ledger-sum")!;
    expect(a.files).toEqual(a2.files);
    expect(a.files).not.toEqual(b.files);
  });
});
