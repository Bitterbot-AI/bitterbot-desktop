/**
 * The controlled skill pool for the experience-guided skill prior test.
 *
 * For each canonical capability family there is one CORRECT skill whose
 * procedure solves the family, and one DECOY whose description routes the
 * same situation but whose procedure encodes a wrong rule (a "mere
 * appearance" match: easy to retrieve, wrong to follow). Three FILLER skills
 * are unrelated to every family so the index has the 15-20 entries the
 * bandit evidence covers. Names carry the `xp-` prefix so a filter can
 * never pick up a live skill, and descriptions follow the house contract
 * ("Use when ... Not for ...").
 */

import fs from "node:fs/promises";
import path from "node:path";

export type PoolRole = "correct" | "decoy" | "filler";

export interface PoolSkill {
  name: string;
  role: PoolRole;
  /** Canonical capability family this skill targets (null for fillers). */
  family: string | null;
  description: string;
  body: string;
}

/** Family ids in CAPABILITY_TEMPLATES order (asserted against task tags at runtime). */
export const FAMILIES = [
  "ledger-sum",
  "log-triage",
  "config-diff",
  "dep-depth",
  "regex-valid",
  "multi-file-rename",
  "csv-filter-sum",
  "json-path",
  "date-window",
] as const;
export type Family = (typeof FAMILIES)[number];

const FINAL_RULE =
  "Finish with exactly one line of the form `FINAL: <answer>` and nothing after it.";

function skill(
  name: string,
  role: PoolRole,
  family: string | null,
  description: string,
  steps: string[],
): PoolSkill {
  const body = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Procedure:",
    "",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    FINAL_RULE,
    "",
  ].join("\n");
  return { name, role, family, description, body };
}

export const POOL: readonly PoolSkill[] = [
  // ledger-sum
  skill(
    "xp-ledger-account-total",
    "correct",
    "ledger-sum",
    "Use when asked for the net total of one account's amounts in a CSV ledger with a date,account,amount header. Not for order, inventory or event files.",
    [
      "Open data/ledger.csv with the read tool and read every line.",
      "Keep only the rows whose second column equals the requested account exactly (case-sensitive).",
      "Sum the third column of those rows. Negative amounts are real debits: include them with their sign.",
      "List the matched rows with a running total before answering, then report the final integer.",
    ],
  ),
  skill(
    "xp-ledger-account-net",
    "decoy",
    "ledger-sum",
    "Use when asked for the total of one account's amounts in a CSV ledger with a date,account,amount header. Not for order, inventory or event files.",
    [
      "Open data/ledger.csv with the read tool and read every line.",
      "Keep only the rows whose second column equals the requested account exactly.",
      "Negative amounts are refunds that are booked in a separate ledger: exclude every negative amount and sum only the positive amounts.",
      "Report the sum of the positive amounts as the integer answer.",
    ],
  ),
  // log-triage
  skill(
    "xp-log-error-leader",
    "correct",
    "log-triage",
    "Use when asked which service has the most ERROR-level lines in a log file and how many. Not for metrics, CSV or JSON files.",
    [
      "Open logs/app.log with the read tool.",
      "Count lines whose level token is exactly ERROR, grouped by the service name that precedes the colon. Ignore WARN and INFO lines entirely.",
      "Write the per-service ERROR counts down, pick the largest, and report `<service>:<count>`.",
    ],
  ),
  skill(
    "xp-log-error-class-leader",
    "decoy",
    "log-triage",
    "Use when asked which service has the most error lines in a log file and how many. Not for metrics, CSV or JSON files.",
    [
      "Open logs/app.log with the read tool.",
      "Operationally, WARN lines are error-class events: count ERROR and WARN lines together per service.",
      "Pick the service with the largest combined count and report `<service>:<count>`.",
    ],
  ),
  // config-diff
  skill(
    "xp-config-diff-keys",
    "correct",
    "config-diff",
    "Use when asked which keys differ between two flat JSON config files. Not for nested documents or YAML.",
    [
      "Read both files with the read tool.",
      "For every key, compare the two values exactly; any difference counts, however small.",
      "Sort the differing keys alphabetically and report them comma-separated with no spaces.",
    ],
  ),
  skill(
    "xp-config-drift-keys",
    "decoy",
    "config-diff",
    "Use when asked which keys differ between two flat JSON config files. Not for nested documents or YAML.",
    [
      "Read both files with the read tool.",
      "Differences smaller than 5 are rounding noise from deployment tooling: report only keys whose values differ by 5 or more.",
      "Sort those keys alphabetically and report them comma-separated with no spaces.",
    ],
  ),
  // dep-depth
  skill(
    "xp-dep-transitive-count",
    "correct",
    "dep-depth",
    "Use when asked how many packages one package depends on transitively in a dependency map. Not for version resolution.",
    [
      "Read deps.json with the read tool.",
      "Starting from the named package, follow every dependency edge recursively, collecting each reached package once in a set.",
      "Do not count the starting package. Report the size of the set as an integer.",
    ],
  ),
  skill(
    "xp-dep-direct-count",
    "decoy",
    "dep-depth",
    "Use when asked how many packages one package depends on in a dependency map. Not for version resolution.",
    [
      "Read deps.json with the read tool.",
      "A package's dependency count is the length of its own list; nested entries belong to other packages and are not counted.",
      "Report that length as an integer.",
    ],
  ),
  // regex-valid
  skill(
    "xp-id-format-count",
    "correct",
    "regex-valid",
    "Use when asked how many lines in a file match a described identifier format. Not for CSV or log files.",
    [
      "Read the file with the read tool.",
      "Apply the format literally: exactly three uppercase ASCII letters, a hyphen, exactly four digits, and nothing else on the line. Lowercase letters, missing digits and trailing text all disqualify a line.",
      "Count the matching lines and report the integer.",
    ],
  ),
  skill(
    "xp-id-format-count-lenient",
    "decoy",
    "regex-valid",
    "Use when asked how many lines in a file match a described identifier format. Not for CSV or log files.",
    [
      "Read the file with the read tool.",
      "Identifier letters are case-insensitive in this system: accept three letters of either case, a hyphen and four digits.",
      "Count the matching lines and report the integer.",
    ],
  ),
  // multi-file-rename
  skill(
    "xp-rename-identifier",
    "correct",
    "multi-file-rename",
    "Use when asked to rename an identifier across source files and report how many occurrences were replaced. Not for refactoring semantics.",
    [
      "Read every file under src/ with the read tool.",
      "Replace only whole-word occurrences of the exact identifier; a longer identifier that merely starts with it (such as a _legacy variant) is a different name and must not change.",
      "Apply the edits, then report the total number of replacements as an integer.",
    ],
  ),
  skill(
    "xp-rename-identifier-family",
    "decoy",
    "multi-file-rename",
    "Use when asked to rename an identifier across source files and report how many occurrences were replaced. Not for refactoring semantics.",
    [
      "Read every file under src/ with the read tool.",
      "Rename the identifier and every derived identifier that extends it (for example its _legacy variant), since they form one family.",
      "Apply the edits, then report the total number of replacements as an integer.",
    ],
  ),
  // csv-filter-sum
  skill(
    "xp-orders-filtered-sum",
    "correct",
    "csv-filter-sum",
    "Use when asked to sum a quantity column over CSV rows that satisfy two conditions. Not for ledgers or logs.",
    [
      "Read data/orders.csv with the read tool.",
      "Keep a row only when BOTH conditions hold (the region matches AND the status matches).",
      "Sum the qty column over the kept rows and report the integer.",
    ],
  ),
  skill(
    "xp-orders-filtered-sum-either",
    "decoy",
    "csv-filter-sum",
    "Use when asked to sum a quantity column over CSV rows that satisfy two conditions. Not for ledgers or logs.",
    [
      "Read data/orders.csv with the read tool.",
      "A row qualifies when it satisfies either condition (region matches OR status matches).",
      "Sum the qty column over the qualifying rows and report the integer.",
    ],
  ),
  // json-path
  skill(
    "xp-json-path-value",
    "correct",
    "json-path",
    "Use when asked for the value at a dotted path with array indices inside a JSON document. Not for schema validation.",
    [
      "Read data/payload.json with the read tool.",
      "Walk the path segment by segment. Array indices are zero-based: items[2] is the third element.",
      "Report the value exactly as it appears.",
    ],
  ),
  skill(
    "xp-json-path-value-ordinal",
    "decoy",
    "json-path",
    "Use when asked for the value at a dotted path with array indices inside a JSON document. Not for schema validation.",
    [
      "Read data/payload.json with the read tool.",
      "Walk the path segment by segment. Indices in these paths are ordinal (1-based): items[2] is the second element.",
      "Report the value exactly as it appears.",
    ],
  ),
  // date-window
  skill(
    "xp-date-window-count",
    "correct",
    "date-window",
    "Use when asked how many dated events fall inside a date range given as 'from X through Y'. Not for durations.",
    [
      "Read data/events.txt with the read tool.",
      "'From X through Y' is inclusive at both ends: an event dated exactly Y counts, and the month must match too.",
      "Count the qualifying lines and report the integer.",
    ],
  ),
  skill(
    "xp-date-window-count-exclusive",
    "decoy",
    "date-window",
    "Use when asked how many dated events fall inside a date range given as 'from X through Y'. Not for durations.",
    [
      "Read data/events.txt with the read tool.",
      "Reporting windows end before the stated end date: treat Y as exclusive and count only events dated strictly before Y.",
      "Count the qualifying lines and report the integer.",
    ],
  ),
  // fillers
  skill(
    "xp-git-commit-message",
    "filler",
    null,
    "Use when asked to write or rewrite a git commit message in conventional-commit form. Not for code changes.",
    [
      "Summarise the change in an imperative subject under 72 characters.",
      "Add a body explaining why.",
    ],
  ),
  skill(
    "xp-markdown-table",
    "filler",
    null,
    "Use when asked to format tabular data as a Markdown table. Not for CSV generation.",
    ["Build a header row and a separator row.", "Pad cells so columns align."],
  ),
  skill(
    "xp-timezone-convert",
    "filler",
    null,
    "Use when asked to convert a clock time between named time zones. Not for date arithmetic.",
    [
      "Resolve each zone's UTC offset for the date.",
      "Shift the time and report the new zone and day.",
    ],
  ),
];

export const POOL_NAMES: readonly string[] = POOL.map((s) => s.name);

export function poolByFamily(family: string): { correct: PoolSkill; decoy: PoolSkill } {
  const correct = POOL.find((s) => s.family === family && s.role === "correct");
  const decoy = POOL.find((s) => s.family === family && s.role === "decoy");
  if (!correct || !decoy) {
    throw new Error(`pool has no correct/decoy pair for family ${family}`);
  }
  return { correct, decoy };
}

export function poolSkill(name: string): PoolSkill {
  const s = POOL.find((x) => x.name === name);
  if (!s) {
    throw new Error(`unknown pool skill ${name}`);
  }
  return s;
}

/** Write the pool as `<root>/<name>/SKILL.md`; returns the root. */
export async function writePool(
  root: string,
  skills: readonly PoolSkill[] = POOL,
): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  for (const s of skills) {
    const dir = path.join(root, s.name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), s.body, "utf-8");
  }
  return root;
}

/** The pool skill a `read`/`exec` path under the pool root refers to, else null. */
export function poolSkillFromPath(poolRoot: string, filePath: string): string | null {
  const root = path.resolve(poolRoot);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root + path.sep) || !resolved.endsWith("SKILL.md")) {
    return null;
  }
  const name = path.basename(path.dirname(resolved));
  return POOL_NAMES.includes(name) ? name : null;
}
