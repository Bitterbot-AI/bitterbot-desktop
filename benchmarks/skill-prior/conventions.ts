/**
 * Latent-convention twins: a harder pool for the skill-memory test.
 *
 * Each of nine task families has FOUR skills with the identical description
 * and four different house conventions (refunds in or out of an account
 * total, WARN counted as an error or not, zero- or one-based paths, ...).
 * Every generated instance is built so the four conventions give four
 * different answers. Which convention is right is a property of the
 * WORKSPACE (environment) the task runs in, fixed by a seeded, balanced
 * assignment and never stated in the prompt or the files. A fresh agent can
 * only guess (about 25% right); verified experience from earlier tasks in
 * the same workspace is the only thing that can tell it which variant holds.
 *
 * The memory cell is `<env>:<family>`. Names are matched in shape
 * (`xp-<family>-a` .. `-d`) and assignments are balanced (each convention
 * is right in exactly two of the eight workspaces per family), so neither a
 * name nor a letter carries information.
 */

import { createHash } from "node:crypto";
import type { CorpusTask } from "../../src/memory/skill-evolution/task-corpus.js";
import { FAMILIES, type Family, type PoolSkill } from "./pool.js";
import { mulberry32 } from "./tasks.js";

type Rng = () => number;

export const ENVS = [
  "alder",
  "birch",
  "cedar",
  "dunmore",
  "elm",
  "fenwick",
  "garnet",
  "holloway",
] as const;
export type Env = (typeof ENVS)[number];

export const VARIANTS = ["a", "b", "c", "d"] as const;
export type Variant = (typeof VARIANTS)[number];

const FINAL_RULE =
  "Finish with exactly one line of the form `FINAL: <answer>` and nothing after it.";

interface Generated {
  prompt: string;
  files: Record<string, string>;
  /** Answer under each convention, indexed like VARIANTS. */
  truths: [string, string, string, string];
}

interface FamilySpec {
  family: Family;
  /** Identical for all four skills of the family. */
  description: string;
  /** Procedure steps per convention, indexed like VARIANTS. */
  steps: [string[], string[], string[], string[]];
  generate: (rng: Rng) => Generated;
}

const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
function shuffle<T>(rng: Rng, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const day = (rng: Rng) => `2026-03-${String(int(rng, 1, 28)).padStart(2, "0")}`;

// ---------------------------------------------------------------- families

const ledger: FamilySpec = {
  family: "ledger-sum",
  description:
    "Use when asked for one account's total from a CSV ledger with date,account,amount,memo columns. Workspaces book totals differently and this is one house convention. Not for order, inventory or event files.",
  steps: [
    [
      "Read data/ledger.csv with the read tool.",
      "Keep every row whose account column equals the requested account exactly.",
      "House convention: the total is the net of ALL kept rows, including the opening balance and refunds, each with its sign.",
      "Report the integer total.",
    ],
    [
      "Read data/ledger.csv with the read tool.",
      "Keep every row whose account column equals the requested account exactly.",
      "House convention: refunds are booked in a separate ledger, so drop rows whose memo is `refund`; keep the opening balance and everything else with its sign.",
      "Report the integer total.",
    ],
    [
      "Read data/ledger.csv with the read tool.",
      "Keep every row whose account column equals the requested account exactly.",
      "House convention: the total covers the period's activity only, so drop the row whose memo is `opening balance`; keep refunds and everything else with its sign.",
      "Report the integer total.",
    ],
    [
      "Read data/ledger.csv with the read tool.",
      "Keep every row whose account column equals the requested account exactly.",
      "House convention: drop both the `opening balance` row and every `refund` row; sum the remaining rows with their signs.",
      "Report the integer total.",
    ],
  ],
  generate(rng) {
    const accounts = shuffle(rng, ["acme", "globex", "initech", "umbrella"]);
    const target = accounts[0]!;
    const rows: Array<{ account: string; amount: number; memo: string }> = [];
    rows.push({ account: target, amount: int(rng, 120, 900), memo: "opening balance" });
    for (let i = int(rng, 1, 3); i > 0; i--) {
      rows.push({ account: target, amount: -int(rng, 10, 150), memo: "refund" });
    }
    for (let i = int(rng, 3, 5); i > 0; i--) {
      rows.push({ account: target, amount: int(rng, 20, 400), memo: "sale" });
    }
    for (let i = int(rng, 1, 2); i > 0; i--) {
      rows.push({ account: target, amount: -int(rng, 5, 60), memo: "fee" });
    }
    for (let i = int(rng, 5, 8); i > 0; i--) {
      const memo = pick(rng, ["sale", "sale", "fee", "refund", "opening balance"]);
      const amount = memo === "sale" ? int(rng, 20, 400) : -int(rng, 5, 150);
      rows.push({
        account: pick(rng, accounts.slice(1)),
        amount: memo === "opening balance" ? int(rng, 120, 900) : amount,
        memo,
      });
    }
    const lines = shuffle(rng, rows).map((r) => `${day(rng)},${r.account},${r.amount},${r.memo}`);
    const mine = rows.filter((r) => r.account === target);
    const tot = (keep: (r: (typeof rows)[number]) => boolean) =>
      String(sum(mine.filter(keep).map((r) => r.amount)));
    return {
      prompt: `What is the total for account ${target} in data/ledger.csv?`,
      files: { "data/ledger.csv": ["date,account,amount,memo", ...lines, ""].join("\n") },
      truths: [
        tot(() => true),
        tot((r) => r.memo !== "refund"),
        tot((r) => r.memo !== "opening balance"),
        tot((r) => r.memo !== "refund" && r.memo !== "opening balance"),
      ],
    };
  },
};

const logTriage: FamilySpec = {
  family: "log-triage",
  description:
    "Use when asked which service logged the most errors in logs/app.log and how many. Workspaces classify errors differently and this is one house convention. Not for metrics, CSV or JSON files.",
  steps: [
    [
      "Read logs/app.log with the read tool.",
      "House convention: an error is a line whose level token is exactly ERROR. WARN, FATAL and INFO lines are not counted.",
      "Count errors per service (the name before the colon), pick the largest, and report `<service>:<count>`.",
    ],
    [
      "Read logs/app.log with the read tool.",
      "House convention: ERROR and WARN lines are both error-class events; count them together. FATAL and INFO lines are not counted.",
      "Count per service (the name before the colon), pick the largest, and report `<service>:<count>`.",
    ],
    [
      "Read logs/app.log with the read tool.",
      "House convention: ERROR and FATAL lines are both errors; count them together. WARN and INFO lines are not counted.",
      "Count per service (the name before the colon), pick the largest, and report `<service>:<count>`.",
    ],
    [
      "Read logs/app.log with the read tool.",
      "House convention: an error is an ERROR-level line, except lines tagged `[retry]`, which are transient and not counted. WARN, FATAL and INFO lines are not counted.",
      "Count per service (the name before the colon), pick the largest, and report `<service>:<count>`.",
    ],
  ],
  generate(rng) {
    const services = shuffle(rng, ["auth", "billing", "search", "gateway", "mailer"]).slice(0, 4);
    const counts = services.map((s) => {
      const error = int(rng, 1, 7);
      return {
        s,
        error,
        retry: int(rng, 0, Math.min(3, error)),
        warn: int(rng, 0, 7),
        fatal: int(rng, 0, 4),
        info: int(rng, 1, 4),
      };
    });
    const lines: string[] = [];
    for (const c of counts) {
      for (let i = 0; i < c.error; i++) {
        lines.push(`ERROR ${c.s}: request failed${i < c.retry ? " [retry]" : ""}`);
      }
      for (let i = 0; i < c.warn; i++) {
        lines.push(`WARN ${c.s}: slow response`);
      }
      for (let i = 0; i < c.fatal; i++) {
        lines.push(`FATAL ${c.s}: worker crashed`);
      }
      for (let i = 0; i < c.info; i++) {
        lines.push(`INFO ${c.s}: ok`);
      }
    }
    const leader = (score: (c: (typeof counts)[number]) => number): string => {
      const scored = counts.map((c) => ({ s: c.s, n: score(c) })).toSorted((x, y) => y.n - x.n);
      // A tie has no single answer: mark it so the instance is rejected.
      return scored[0]!.n === scored[1]!.n ? "tie" : `${scored[0]!.s}:${scored[0]!.n}`;
    };
    const body = shuffle(rng, lines)
      .map((l, i) => `2026-03-04 10:${String(i).padStart(2, "0")}:00 ${l}`)
      .join("\n");
    return {
      prompt: "Which service logged the most errors in logs/app.log, and how many?",
      files: { "logs/app.log": `${body}\n` },
      truths: [
        leader((c) => c.error),
        leader((c) => c.error + c.warn),
        leader((c) => c.error + c.fatal),
        leader((c) => c.error - c.retry),
      ],
    };
  },
};

const configDiff: FamilySpec = {
  family: "config-diff",
  description:
    "Use when asked which keys differ between config/old.json and config/new.json. Workspaces judge drift differently and this is one house convention. Not for nested documents or YAML.",
  steps: [
    [
      "Read both files with the read tool.",
      "House convention: any difference in a key's value counts, however small, including case-only changes and keys that start with an underscore.",
      "Sort the differing keys alphabetically and report them comma-separated with no spaces.",
    ],
    [
      "Read both files with the read tool.",
      "House convention: numeric differences smaller than 5 are rounding noise and do not count; every other difference counts.",
      "Sort the differing keys alphabetically and report them comma-separated with no spaces.",
    ],
    [
      "Read both files with the read tool.",
      "House convention: string values are case-insensitive, so a change only in letter case does not count; every other difference counts.",
      "Sort the differing keys alphabetically and report them comma-separated with no spaces.",
    ],
    [
      "Read both files with the read tool.",
      "House convention: keys starting with an underscore are internal bookkeeping and are ignored; every other difference counts.",
      "Sort the differing keys alphabetically and report them comma-separated with no spaces.",
    ],
  ],
  generate(rng) {
    const names = shuffle(rng, [
      "timeout",
      "retries",
      "workers",
      "cache_ttl",
      "batch_size",
      "port",
      "pool_max",
      "queue_depth",
    ]);
    const strNames = shuffle(rng, ["log_level", "region", "mode", "theme", "env_name"]);
    const words = ["Info", "Debug", "Eu-West", "Strict", "Dark", "Prod", "Batch"];
    const oldC: Record<string, string | number> = {};
    const newC: Record<string, string | number> = {};
    const kinds: Array<{ key: string; kind: string }> = [];
    let n = 0;
    const take = () => names[n++]!;
    let sN = 0;
    const takeS = () => strNames[sN++]!;
    const add = (key: string, kind: string, o: string | number, v: string | number) => {
      oldC[key] = o;
      newC[key] = v;
      kinds.push({ key, kind });
    };
    for (let i = int(rng, 1, 2); i > 0; i--) {
      const o = int(rng, 10, 200);
      add(take(), "big", o, o + int(rng, 6, 40));
    }
    for (let i = int(rng, 1, 2); i > 0; i--) {
      const o = int(rng, 10, 200);
      add(take(), "small", o, o + pick(rng, [-4, -3, -2, -1, 1, 2, 3, 4]));
    }
    for (let i = int(rng, 1, 2); i > 0; i--) {
      const w = pick(rng, words);
      add(takeS(), "case", w, w.toLowerCase());
    }
    {
      const w = pick(rng, words);
      add(
        takeS(),
        "str",
        w,
        pick(
          rng,
          words.filter((x) => x !== w),
        ),
      );
    }
    {
      const o = int(rng, 1, 50);
      add(
        `_${pick(rng, ["revision", "build_id", "synced_at"])}`,
        "internal",
        o,
        o + int(rng, 6, 90),
      );
    }
    for (let i = int(rng, 2, 3); i > 0; i--) {
      const o = int(rng, 1, 500);
      add(take(), "same", o, o);
    }
    const order = shuffle(
      rng,
      kinds.map((k) => k.key),
    );
    const dump = (c: Record<string, string | number>) =>
      `${JSON.stringify(Object.fromEntries(order.map((k) => [k, c[k]])), null, 2)}\n`;
    const diff = (skip: (kind: string) => boolean) =>
      kinds
        .filter((k) => k.kind !== "same" && !skip(k.kind))
        .map((k) => k.key)
        .toSorted()
        .join(",");
    return {
      prompt: "Which keys differ between config/old.json and config/new.json?",
      files: { "config/old.json": dump(oldC), "config/new.json": dump(newC) },
      truths: [
        diff(() => false),
        diff((k) => k === "small"),
        diff((k) => k === "case"),
        diff((k) => k === "internal"),
      ],
    };
  },
};

const depDepth: FamilySpec = {
  family: "dep-depth",
  description:
    "Use when asked how many packages one package depends on in deps.json. Workspaces count dependencies differently and this is one house convention. Not for version resolution.",
  steps: [
    [
      "Read deps.json with the read tool. Each package lists runtime `deps` and development `dev` dependencies.",
      "House convention: count runtime dependencies transitively: follow `deps` edges recursively (never `dev`), collecting each reached package once.",
      "Do not count the starting package. Report the size of the set.",
    ],
    [
      "Read deps.json with the read tool. Each package lists runtime `deps` and development `dev` dependencies.",
      "House convention: count only the package's own direct `deps` list; nested and `dev` entries are not counted.",
      "Report that length.",
    ],
    [
      "Read deps.json with the read tool. Each package lists runtime `deps` and development `dev` dependencies.",
      "House convention: count transitively through BOTH `deps` and `dev` edges, recursively, collecting each reached package once.",
      "Do not count the starting package. Report the size of the set.",
    ],
    [
      "Read deps.json with the read tool. Each package lists runtime `deps` and development `dev` dependencies.",
      "House convention: count the package's own direct `deps` plus its own direct `dev` entries (each package once); nested entries are not counted.",
      "Report that number.",
    ],
  ],
  generate(rng) {
    const pkgs = shuffle(rng, [
      "core",
      "utils",
      "http",
      "cli",
      "auth",
      "db",
      "cache",
      "log",
      "config",
      "queue",
      "metrics",
      "test-kit",
    ]);
    const graph: Record<string, { deps: string[]; dev: string[] }> = {};
    pkgs.forEach((p, i) => {
      const later = pkgs.slice(i + 1);
      graph[p] = {
        deps: shuffle(rng, later).slice(0, Math.min(later.length, int(rng, 0, 3))),
        dev: shuffle(rng, later).slice(0, Math.min(later.length, int(rng, 0, 2))),
      };
    });
    const target = pkgs[0]!;
    const reach = (useDev: boolean) => {
      const seen = new Set<string>();
      const stack = [target];
      while (stack.length) {
        const p = stack.pop()!;
        for (const q of [...graph[p]!.deps, ...(useDev ? graph[p]!.dev : [])]) {
          if (!seen.has(q)) {
            seen.add(q);
            stack.push(q);
          }
        }
      }
      return String(seen.size);
    };
    const t = graph[target]!;
    return {
      prompt: `How many packages does ${target} depend on, according to deps.json?`,
      files: { "deps.json": `${JSON.stringify(graph, null, 2)}\n` },
      truths: [
        reach(false),
        String(t.deps.length),
        reach(true),
        String(new Set([...t.deps, ...t.dev]).size),
      ],
    };
  },
};

const regexValid: FamilySpec = {
  family: "regex-valid",
  description:
    "Use when asked how many lines of data/ids.txt are valid identifiers. Workspaces validate identifiers differently and this is one house convention. Not for CSV or log files.",
  steps: [
    [
      "Read data/ids.txt with the read tool.",
      "House convention: a valid identifier is exactly three UPPERCASE letters, a hyphen, and exactly four digits, with nothing else on the line.",
      "Count the valid lines and report the integer.",
    ],
    [
      "Read data/ids.txt with the read tool.",
      "House convention: identifier letters are case-insensitive: three letters of either case, a hyphen, and exactly four digits, with nothing else on the line.",
      "Count the valid lines and report the integer.",
    ],
    [
      "Read data/ids.txt with the read tool.",
      "House convention: three UPPERCASE letters and exactly four digits, with the hyphen between them optional (ABC-1234 and ABC1234 are both valid); nothing else on the line.",
      "Count the valid lines and report the integer.",
    ],
    [
      "Read data/ids.txt with the read tool.",
      "House convention: exactly three UPPERCASE letters, a hyphen and exactly four digits, but identifiers with the letters TST are test fixtures and are NOT valid.",
      "Count the valid lines and report the integer.",
    ],
  ],
  generate(rng) {
    const L = () => String.fromCharCode(65 + int(rng, 0, 25));
    const D = (k: number) => Array.from({ length: k }, () => String(int(rng, 0, 9))).join("");
    const letters = () => {
      let s = L() + L() + L();
      while (s === "TST") {
        s = L() + L() + L();
      }
      return s;
    };
    const items: Array<{ line: string; kind: string }> = [];
    const add = (k: number, kind: string, make: () => string) => {
      for (let i = 0; i < k; i++) {
        items.push({ line: make(), kind });
      }
    };
    add(int(rng, 3, 6), "strict", () => `${letters()}-${D(4)}`);
    add(int(rng, 1, 3), "lower", () => {
      const s = letters();
      return `${s[0]}${s.slice(1).toLowerCase()}-${D(4)}`;
    });
    add(int(rng, 1, 3), "nohyphen", () => `${letters()}${D(4)}`);
    add(int(rng, 1, 2), "tst", () => `TST-${D(4)}`);
    add(int(rng, 1, 3), "junk", () =>
      pick(rng, [`${letters()}-${D(3)}`, `${letters()}-${D(4)} x`, `${L()}${L()}-${D(4)}`]),
    );
    const n = (kinds: string[]) => String(items.filter((i) => kinds.includes(i.kind)).length);
    return {
      prompt: "How many lines in data/ids.txt are valid identifiers?",
      files: {
        "data/ids.txt": `${shuffle(
          rng,
          items.map((i) => i.line),
        ).join("\n")}\n`,
      },
      truths: [
        n(["strict", "tst"]),
        n(["strict", "tst", "lower"]),
        n(["strict", "tst", "nohyphen"]),
        n(["strict"]),
      ],
    };
  },
};

const rename: FamilySpec = {
  family: "multi-file-rename",
  description:
    "Use when asked to rename an identifier across the files under src/ and report how many occurrences were replaced. Workspaces scope renames differently and this is one house convention. Not for refactoring semantics.",
  steps: [
    [
      "Read every file under src/ with the read tool.",
      "House convention: replace every whole-word occurrence of the exact identifier in every file, code and comments alike. Longer names that merely start with it (such as a `_legacy` variant) are different names and stay.",
      "Apply the edits, then report the total number of replacements.",
    ],
    [
      "Read every file under src/ with the read tool.",
      "House convention: rename the identifier and its derived names that extend it (such as its `_legacy` variant) everywhere, code and comments alike; each derived name counts as one replacement.",
      "Apply the edits, then report the total number of replacements.",
    ],
    [
      "Read every file under src/ with the read tool.",
      "House convention: replace whole-word occurrences in code only; comment lines (starting with //) are left untouched and not counted. `_legacy` variants stay.",
      "Apply the edits, then report the total number of replacements.",
    ],
    [
      "Read every file under src/ with the read tool.",
      "House convention: test files (`*.test.ts`) are owned by another team and are left untouched; replace whole-word occurrences, code and comments alike, in every other file. `_legacy` variants stay.",
      "Apply the edits, then report the total number of replacements.",
    ],
  ],
  generate(rng) {
    const [oldName, newName] = pick(rng, [
      ["fetchUser", "loadUser"],
      ["parseDate", "readDate"],
      ["sendMail", "deliverMail"],
      ["buildQuery", "composeQuery"],
    ] as const);
    let whole = 0;
    let wholeCode = 0;
    let wholeTest = 0;
    let legacy = 0;
    const file = (isTest: boolean) => {
      const lines: string[] = [];
      for (let i = int(rng, 1, 3); i > 0; i--) {
        lines.push(`export const x${int(rng, 1, 99)} = ${oldName}(input);`);
        whole++;
        wholeCode++;
        if (isTest) {
          wholeTest++;
        }
      }
      for (let i = int(rng, 0, 2); i > 0; i--) {
        lines.push(`// ${oldName} is called before render`);
        whole++;
        if (isTest) {
          wholeTest++;
        }
      }
      for (let i = int(rng, 0, 1); i > 0; i--) {
        lines.push(`const old${int(rng, 1, 99)} = ${oldName}_legacy(input);`);
        legacy++;
      }
      lines.push(`export const ready = true;`);
      return `${shuffle(rng, lines).join("\n")}\n`;
    };
    const files: Record<string, string> = {
      "src/api.ts": file(false),
      "src/view.ts": file(false),
      "src/api.test.ts": file(true),
    };
    return {
      prompt: `Rename ${oldName} to ${newName} across the files under src/ and report how many occurrences you replaced.`,
      files,
      truths: [String(whole), String(whole + legacy), String(wholeCode), String(whole - wholeTest)],
    };
  },
};

const csvFilter: FamilySpec = {
  family: "csv-filter-sum",
  description:
    "Use when asked for the total quantity of shipped orders in one region from data/orders.csv. Workspaces count shipments differently and this is one house convention. Not for ledgers or logs.",
  steps: [
    [
      "Read data/orders.csv with the read tool.",
      "House convention: keep rows whose region equals the requested region exactly AND whose status is exactly `shipped`.",
      "Sum the qty column over the kept rows and report the integer.",
    ],
    [
      "Read data/orders.csv with the read tool.",
      "House convention: `delivered` orders were shipped too: keep rows whose region equals the requested region exactly and whose status is `shipped` or `delivered`.",
      "Sum the qty column over the kept rows and report the integer.",
    ],
    [
      "Read data/orders.csv with the read tool.",
      "House convention: keep rows whose region equals the requested region exactly and whose status is exactly `shipped`, and count net units: qty minus the returned column.",
      "Sum the net units over the kept rows and report the integer.",
    ],
    [
      "Read data/orders.csv with the read tool.",
      "House convention: a region includes its sub-regions: keep rows whose region is the requested region or starts with it followed by a hyphen (EU-NORTH counts for EU), and whose status is exactly `shipped`.",
      "Sum the qty column over the kept rows and report the integer.",
    ],
  ],
  generate(rng) {
    const region = pick(rng, ["EU", "US", "APAC"]);
    const others = ["EU", "US", "APAC"].filter((r) => r !== region);
    const rows: Array<{ region: string; status: string; qty: number; returned: number }> = [];
    const row = (r: string, status: string, returned = 0) =>
      rows.push({ region: r, status, qty: int(rng, 2, 40), returned });
    for (let i = int(rng, 2, 4); i > 0; i--) {
      row(region, "shipped", i === 1 ? int(rng, 1, 2) : 0);
    }
    for (let i = int(rng, 1, 2); i > 0; i--) {
      row(region, "delivered");
    }
    for (let i = int(rng, 1, 2); i > 0; i--) {
      row(`${region}-${pick(rng, ["NORTH", "SOUTH", "WEST"])}`, "shipped");
    }
    row(region, pick(rng, ["pending", "cancelled"]));
    for (let i = int(rng, 3, 5); i > 0; i--) {
      row(pick(rng, others), pick(rng, ["shipped", "delivered", "pending"]));
    }
    const lines = shuffle(rng, rows).map(
      (r, i) => `${1001 + i},${r.region},${r.status},${r.qty},${r.returned}`,
    );
    const total = (keep: (r: (typeof rows)[number]) => boolean, net = false) =>
      String(sum(rows.filter(keep).map((r) => (net ? r.qty - r.returned : r.qty))));
    return {
      prompt: `What is the total qty of shipped orders in region ${region} in data/orders.csv?`,
      files: {
        "data/orders.csv": ["id,region,status,qty,returned", ...lines, ""].join("\n"),
      },
      truths: [
        total((r) => r.region === region && r.status === "shipped"),
        total((r) => r.region === region && (r.status === "shipped" || r.status === "delivered")),
        total((r) => r.region === region && r.status === "shipped", true),
        total(
          (r) =>
            (r.region === region || r.region.startsWith(`${region}-`)) && r.status === "shipped",
        ),
      ],
    };
  },
};

const jsonPath: FamilySpec = {
  family: "json-path",
  description:
    "Use when asked for the name at items[N] in data/payload.json. Workspaces index item lists differently and this is one house convention. Not for schema validation.",
  steps: [
    [
      "Read data/payload.json with the read tool.",
      "House convention: indices are zero-based over the full items array, archived items included: items[2] is the third element.",
      "Report that item's name exactly as it appears.",
    ],
    [
      "Read data/payload.json with the read tool.",
      "House convention: indices are one-based over the full items array, archived items included: items[2] is the second element.",
      "Report that item's name exactly as it appears.",
    ],
    [
      "Read data/payload.json with the read tool.",
      'House convention: archived items (`"archived": true`) are invisible: drop them first, then index zero-based: items[2] is the third remaining item.',
      "Report that item's name exactly as it appears.",
    ],
    [
      "Read data/payload.json with the read tool.",
      'House convention: archived items (`"archived": true`) are invisible: drop them first, then index one-based: items[2] is the second remaining item.',
      "Report that item's name exactly as it appears.",
    ],
  ],
  generate(rng) {
    const names = shuffle(rng, [
      "anvil",
      "beacon",
      "copper",
      "delta",
      "ember",
      "falcon",
      "glacier",
      "harbor",
      "iris",
      "juniper",
    ]);
    const items = names
      .slice(0, int(rng, 8, 10))
      .map((name, i) => ({ name, archived: i < 5 && rng() < 0.4 }));
    const k = int(rng, 2, 4);
    const active = items.filter((i) => !i.archived);
    const at = (xs: typeof items, i: number) => xs[i]?.name ?? "none";
    return {
      prompt: `What is the name of items[${k}] in data/payload.json?`,
      files: { "data/payload.json": `${JSON.stringify({ items }, null, 2)}\n` },
      truths: [at(items, k), at(items, k - 1), at(active, k), at(active, k - 1)],
    };
  },
};

const dateWindow: FamilySpec = {
  family: "date-window",
  description:
    "Use when asked how many events in data/events.txt fall from one date through another. Workspaces bound reporting windows differently and this is one house convention. Not for durations.",
  steps: [
    [
      "Read data/events.txt with the read tool.",
      "House convention: 'from X through Y' is inclusive at both ends, and every listed event counts, cancelled ones included.",
      "Count the qualifying lines and report the integer.",
    ],
    [
      "Read data/events.txt with the read tool.",
      "House convention: reporting windows end before the stated end date: count events dated X or later and strictly before Y. Cancelled events count.",
      "Count the qualifying lines and report the integer.",
    ],
    [
      "Read data/events.txt with the read tool.",
      "House convention: inclusive at both ends, but events marked `(cancelled)` never happened and are not counted.",
      "Count the qualifying lines and report the integer.",
    ],
    [
      "Read data/events.txt with the read tool.",
      "House convention: count events dated X or later and strictly before Y, and skip events marked `(cancelled)`.",
      "Count the qualifying lines and report the integer.",
    ],
  ],
  generate(rng) {
    const from = int(rng, 3, 9);
    const to = from + int(rng, 6, 12);
    const dates: Array<{ d: number; cancelled: boolean }> = [];
    for (let i = int(rng, 1, 2); i > 0; i--) {
      dates.push({ d: to, cancelled: i === 2 });
    }
    for (let i = int(rng, 3, 6); i > 0; i--) {
      dates.push({ d: int(rng, from, to - 1), cancelled: false });
    }
    for (let i = int(rng, 1, 2); i > 0; i--) {
      dates.push({ d: int(rng, from, to - 1), cancelled: true });
    }
    for (let i = int(rng, 2, 4); i > 0; i--) {
      dates.push({ d: pick(rng, [int(rng, 1, from - 1), int(rng, to + 1, 28)]), cancelled: false });
    }
    const titles = ["standup", "review", "deploy", "retro", "demo", "planning", "audit"];
    const fmt = (d: number) => `2026-04-${String(d).padStart(2, "0")}`;
    const lines = shuffle(rng, dates).map(
      (e) => `${fmt(e.d)} ${pick(rng, titles)}${e.cancelled ? " (cancelled)" : ""}`,
    );
    const n = (endIncl: boolean, skipCancelled: boolean) =>
      String(
        dates.filter(
          (e) => e.d >= from && (endIncl ? e.d <= to : e.d < to) && !(skipCancelled && e.cancelled),
        ).length,
      );
    return {
      prompt: `How many events in data/events.txt fall from ${fmt(from)} through ${fmt(to)}?`,
      files: { "data/events.txt": `${lines.join("\n")}\n` },
      truths: [n(true, false), n(false, false), n(true, true), n(false, true)],
    };
  },
};

export const CONVENTION_FAMILIES: Readonly<Record<Family, FamilySpec>> = {
  "ledger-sum": ledger,
  "log-triage": logTriage,
  "config-diff": configDiff,
  "dep-depth": depDepth,
  "regex-valid": regexValid,
  "multi-file-rename": rename,
  "csv-filter-sum": csvFilter,
  "json-path": jsonPath,
  "date-window": dateWindow,
};

// -------------------------------------------------------------------- pool

export function conventionSkillName(family: Family, v: Variant): string {
  return `xp-${family}-${v}`;
}

function skillOf(family: Family, vi: number): PoolSkill {
  const spec = CONVENTION_FAMILIES[family];
  const name = conventionSkillName(family, VARIANTS[vi]!);
  const body = [
    "---",
    `name: ${name}`,
    `description: ${spec.description}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Procedure:",
    "",
    ...spec.steps[vi]!.map((s, i) => `${i + 1}. ${s}`),
    "",
    FINAL_RULE,
    "",
  ].join("\n");
  // role is relative to an environment; the static pool marks none correct.
  return { name, role: "decoy", family, description: spec.description, body };
}

const FILLERS: PoolSkill[] = [
  [
    "xp-git-commit-message",
    "Use when asked to write or rewrite a git commit message in conventional-commit form. Not for code changes.",
  ],
  [
    "xp-markdown-table",
    "Use when asked to format tabular data as a Markdown table. Not for CSV generation.",
  ],
  [
    "xp-timezone-convert",
    "Use when asked to convert a clock time between named time zones. Not for date arithmetic.",
  ],
].map(([name, description]) => ({
  name: name!,
  role: "filler" as const,
  family: null,
  description: description!,
  body: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFollow the request directly.\n`,
}));

export const CONVENTION_POOL: readonly PoolSkill[] = [
  ...FAMILIES.flatMap((f) => VARIANTS.map((_, vi) => skillOf(f, vi))),
  ...FILLERS,
];
export const CONVENTION_POOL_NAMES: readonly string[] = CONVENTION_POOL.map((s) => s.name);

// ------------------------------------------------------------ environments

/**
 * The convention each workspace uses for each family. Balanced: per family,
 * every variant is right in exactly two of the eight workspaces, permuted by
 * a fixed seed so no workspace is "all a" and letters carry nothing.
 */
export function conventionOf(env: Env, family: Family, salt = "conventions-v1"): Variant {
  const fi = FAMILIES.indexOf(family);
  const h = createHash("sha256").update(`${salt}:${family}`).digest();
  const rng = mulberry32(h.readUInt32BE(0) + fi);
  const slots = shuffle(rng, [0, 0, 1, 1, 2, 2, 3, 3]);
  return VARIANTS[slots[ENVS.indexOf(env)]!]!;
}

export interface ConventionInstance {
  task: CorpusTask;
  family: Family;
  env: Env;
  seed: number;
  /** The variant this workspace uses, and its skill. */
  variant: Variant;
  correctSkill: string;
  decoySkills: string[];
  /** Answers under every variant (for audits; the checker uses only the right one). */
  truths: Record<Variant, string>;
}

/** Deterministic instance for (env, family, seed); retries until the four answers differ. */
export function conventionInstance(env: Env, family: Family, seed: number): ConventionInstance {
  const spec = CONVENTION_FAMILIES[family];
  const h = createHash("sha256").update(`${env}:${family}:${seed}`).digest();
  const rng = mulberry32(h.readUInt32BE(0));
  for (let attempt = 0; attempt < 500; attempt++) {
    const g = spec.generate(rng);
    if (new Set(g.truths).size !== 4 || g.truths.some((t) => t.startsWith("tie") || t === "none")) {
      continue;
    }
    const variant = conventionOf(env, family);
    const vi = VARIANTS.indexOf(variant);
    const workspace = env[0]!.toUpperCase() + env.slice(1);
    return {
      task: {
        id: `cv-${family}-${env}-s${seed}`,
        prompt: `You are working in the ${workspace} workspace. ${g.prompt} Several skills cover this task with different house conventions; use the one that fits this workspace.`,
        checker: { kind: "final", value: g.truths[vi]! },
        files: g.files,
        tags: [family, `env:${env}`],
        timeoutMs: 120_000,
      },
      family,
      env,
      seed,
      variant,
      correctSkill: conventionSkillName(family, variant),
      decoySkills: VARIANTS.filter((v) => v !== variant).map((v) => conventionSkillName(family, v)),
      truths: Object.fromEntries(VARIANTS.map((v, i) => [v, g.truths[i]!])) as Record<
        Variant,
        string
      >,
    };
  }
  throw new Error(`could not generate distinct truths for ${env}/${family}/${seed}`);
}
