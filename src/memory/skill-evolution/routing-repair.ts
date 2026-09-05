/**
 * PLAN-44 Phase 5c: ROUTING REPAIR for harvested and received skills.
 *
 * The agent finds a skill only through its description in the runtime
 * index, and opens one only when exactly one description clearly applies.
 * Harvested skills (Skill Seekers) carry repository taglines ("A collective
 * list of free APIs") and received peer skills carry whatever the sender
 * wrote; on this node that meant one skill read in 4,410 runs. The harvest
 * path has no model available at write time, so the rewrite happens here:
 * a housekeeping pass (and an on-demand RPC/CLI) finds live skills whose
 * description fails the contract, asks the model for a contract-compliant
 * "use when … not for …" description grounded in the skill's own body,
 * holds it to the contract and the overlap check, and applies it through
 * the normal staging gate + promote (archived previous version, snapshot
 * bump). The repository identity stays where it already lives (frontmatter
 * `source_url`, `github_full_name`, `.provenance.json`). One rewrite per
 * body hash; the read signal (skill-reads.ts) is the acceptance test.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { LlmCallFn } from "./maintainer.js";
import {
  checkDescriptionContract,
  DESCRIPTION_CONTRACT_PROMPT,
  describeContractIssues,
} from "../../agents/skills/description-contract.js";
import {
  findDescriptionOverlap,
  listLiveSkillIndex,
  type LiveSkillIndexEntry,
} from "../../agents/skills/description-overlap.js";
import { appendImpactEntry, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { skillManage } from "../../agents/skills/skill-manage.js";
import { promoteStaged } from "../../agents/skills/skill-promote.js";
import {
  liveSkillDir,
  liveSkillPath,
  readLive,
  resolveStorageRoots,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseSkillMarkdown } from "../skill-curator-judge.js";
import { extractJsonObjectLenient } from "./json-extract.js";
import { hashProposalContent } from "./proposal-apply.js";

const log = createSubsystemLogger("skill-evolution/routing-repair");

/** Skills rewritten per pass (each costs up to two model calls). */
export const DEFAULT_MAX_REWRITES_PER_PASS = 5;
const BODY_EXCERPT_CHARS = 2_500;
const ATTEMPTS = 2;

export interface RoutingRepairCandidate {
  name: string;
  description: string;
  issues: string[];
}

export interface RoutingRepairOutcome {
  name: string;
  outcome: "rewritten" | "skipped" | "failed";
  from: string;
  to?: string;
  reason: string;
}

export interface RoutingRepairResult {
  examined: number;
  candidates: RoutingRepairCandidate[];
  outcomes: RoutingRepairOutcome[];
  llmCalls: number;
}

interface ProvenanceRewrite {
  at: number;
  from: string;
  to: string;
  bodyHash: string;
}

function bodyHash(skillMd: string): string {
  const parsed = parseSkillMarkdown(skillMd);
  return hashProposalContent(parsed?.body ?? skillMd);
}

async function readProvenance(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, ".provenance.json"), "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** Live skills whose description cannot route (fails the contract on its own terms). */
export async function listNonRoutableSkills(
  opts: ImpactTrailOptions = {},
): Promise<RoutingRepairCandidate[]> {
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const index = await listLiveSkillIndex(roots);
  const out: RoutingRepairCandidate[] = [];
  for (const entry of index) {
    if (entry.contractCompliant) {
      continue;
    }
    let fmName: string | undefined;
    try {
      const fm = (parseSkillMarkdown(await fs.readFile(liveSkillPath(roots, entry.name), "utf-8"))
        ?.frontmatter ?? {}) as Record<string, unknown>;
      fmName = typeof fm.name === "string" ? fm.name : undefined;
    } catch {
      continue;
    }
    // Description checks only: the name is the file's own (a patch keeps it).
    const issues = checkDescriptionContract({
      skillName: entry.name,
      frontmatterName: fmName,
      description: entry.description,
      liveFrontmatterName: fmName ?? entry.name,
    }).filter((i) => i !== "variant-suffix");
    if (issues.length > 0) {
      out.push({ name: entry.name, description: entry.description, issues });
    }
  }
  return out;
}

export function buildRewritePrompt(params: {
  name: string;
  currentDescription: string;
  skillMd: string;
  previousAttempt?: { description: string; problem: string };
}): string {
  const parsed = parseSkillMarkdown(params.skillMd);
  const fm = (parsed?.frontmatter ?? {}) as Record<string, unknown>;
  const source = [fm.source_url, fm.github_full_name, fm.source_type]
    .filter((v) => typeof v === "string")
    .join(" · ");
  const body = (parsed?.body ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BODY_EXCERPT_CHARS);
  return [
    "You write the DESCRIPTION of a skill for an agent runtime's skill router.",
    "The router sees only an index of <name> + <description> and opens a skill when exactly one description clearly applies to the task at hand.",
    "The current description is a source tagline; it says what the source IS, not WHEN an agent should open this skill.",
    "",
    DESCRIPTION_CONTRACT_PROMPT,
    "",
    `Skill name: ${params.name}`,
    source ? `Source: ${source}` : null,
    `Current description: ${params.currentDescription || "(empty)"}`,
    "Skill body (what the agent gets when it opens the skill):",
    body || "(empty)",
    "",
    "Write the situation an agent is in when this skill would help (the kind of question or task, the tool or domain involved), then what it is NOT for.",
    params.previousAttempt
      ? `A previous attempt was refused: "${params.previousAttempt.description}" — ${params.previousAttempt.problem}. Fix that.`
      : null,
    'Reply with exactly one JSON object: {"description": "..."}. Nothing else.',
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function parseRewrite(raw: string): string | null {
  const obj = extractJsonObjectLenient(raw);
  const d =
    obj && typeof (obj as { description?: unknown }).description === "string"
      ? ((obj as { description: string }).description as string)
      : null;
  return d ? d.replace(/\s+/g, " ").trim() : null;
}

/**
 * Rewrite one skill's description. Returns the outcome; applies through
 * the staging gate (strict injection + contract + overlap) and promote.
 */
export async function repairSkillRouting(params: {
  llmCall: LlmCallFn;
  name: string;
  storeOpts?: ImpactTrailOptions;
  liveIndex?: LiveSkillIndexEntry[];
  now?: number;
}): Promise<{ outcome: RoutingRepairOutcome; llmCalls: number }> {
  const opts = params.storeOpts ?? {};
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const trailOpts: ImpactTrailOptions = opts.configDir ? { configDir: opts.configDir } : {};
  const now = params.now ?? Date.now();
  const live = await readLive(roots, params.name);
  if (live === null) {
    return {
      outcome: { name: params.name, outcome: "skipped", from: "", reason: "not live" },
      llmCalls: 0,
    };
  }
  const parsed = parseSkillMarkdown(live);
  const fm = (parsed?.frontmatter ?? {}) as Record<string, unknown>;
  const from = typeof fm.description === "string" ? fm.description : "";
  const fmName = typeof fm.name === "string" ? fm.name : params.name;
  const hash = bodyHash(live);
  const dir = liveSkillDir(roots, params.name);
  const provenance = (await readProvenance(dir)) ?? {};
  const prior = provenance.routing_rewrite as ProvenanceRewrite | undefined;
  if (prior && prior.bodyHash === hash) {
    return {
      outcome: {
        name: params.name,
        outcome: "skipped",
        from,
        reason: "already rewritten for this body",
      },
      llmCalls: 0,
    };
  }
  const liveIndex = params.liveIndex ?? (await listLiveSkillIndex(roots));
  let llmCalls = 0;
  let previousAttempt: { description: string; problem: string } | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    llmCalls += 1;
    const raw = await params.llmCall(
      buildRewritePrompt({
        name: params.name,
        currentDescription: from,
        skillMd: live,
        previousAttempt,
      }),
    );
    const description = parseRewrite(raw);
    if (!description) {
      previousAttempt = { description: "(unparseable)", problem: "reply was not the JSON object" };
      continue;
    }
    const issues = checkDescriptionContract({
      skillName: params.name,
      frontmatterName: fmName,
      description,
      liveFrontmatterName: fmName,
    }).filter((i) => i !== "variant-suffix");
    if (issues.length > 0) {
      previousAttempt = { description, problem: describeContractIssues(issues) };
      continue;
    }
    const hit = findDescriptionOverlap(description, liveIndex, { excludeName: params.name });
    if (hit && liveIndex.find((e) => e.name === hit.name)?.contractCompliant) {
      previousAttempt = {
        description,
        problem: `it overlaps live skill "${hit.name}"; describe a situation that one does not cover`,
      };
      continue;
    }
    // Apply through the normal gate: an edit that changes the description
    // must meet the contract (it does) and clears the overlap check.
    const rewritten = live.replace(/^---\n([\s\S]*?)\n---/, (m) => {
      const lines = m.split("\n");
      const idx = lines.findIndex((l) => /^description\s*:/.test(l));
      const value = /[:#"'\n]/.test(description) ? JSON.stringify(description) : description;
      if (idx >= 0) {
        let end = idx + 1;
        while (end < lines.length && /^\s+\S/.test(lines[end] as string)) {
          end += 1;
        }
        lines.splice(idx, end - idx, `description: ${value}`);
      } else {
        lines.splice(1, 0, `description: ${value}`);
      }
      return lines.join("\n");
    });
    const manage = await skillManage(
      { storageRoots: roots },
      {
        action: "edit",
        name: params.name,
        content: rewritten,
        reason: "routing repair: description rewritten to the contract",
        author: "routing-repair",
        strictInjection: true,
        descriptionContract: true,
      },
    );
    if (!manage.ok) {
      previousAttempt = { description, problem: manage.detail ?? manage.error ?? "gate refused" };
      continue;
    }
    const promoted = await promoteStaged(
      { storageRoots: roots },
      { name: params.name, reason: "routing repair", author: "routing-repair" },
    );
    if (!promoted.ok) {
      return {
        outcome: {
          name: params.name,
          outcome: "failed",
          from,
          to: description,
          reason: promoted.detail ?? promoted.error ?? "promote failed",
        },
        llmCalls,
      };
    }
    const stamp: ProvenanceRewrite = { at: now, from, to: description, bodyHash: hash };
    await fs.writeFile(
      path.join(dir, ".provenance.json"),
      JSON.stringify({ ...provenance, routing_rewrite: stamp }, null, 2),
      "utf-8",
    );
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: liveSkillPath(roots, params.name) });
    await appendImpactEntry(
      {
        source: "evolution",
        action: "edit",
        skillName: params.name,
        verdict: "accepted",
        detail: `routing repair: description rewritten (archived v${promoted.previousArchived?.version ?? "none"}). from="${from.slice(0, 120)}" to="${description.slice(0, 160)}"`,
        contentHash: hashProposalContent(rewritten),
      },
      trailOpts,
    );
    log.info(
      `routing repair: ${params.name}: "${from.slice(0, 60)}" → "${description.slice(0, 80)}"`,
    );
    return {
      outcome: { name: params.name, outcome: "rewritten", from, to: description, reason: "ok" },
      llmCalls,
    };
  }
  return {
    outcome: {
      name: params.name,
      outcome: "failed",
      from,
      reason: previousAttempt
        ? `no compliant rewrite in ${ATTEMPTS} attempts (last: ${previousAttempt.problem})`
        : "no reply",
    },
    llmCalls,
  };
}

/** Housekeeping entry point: rewrite up to `max` non-routable live skills. */
export async function repairNonRoutableSkills(params: {
  llmCall: LlmCallFn;
  storeOpts?: ImpactTrailOptions;
  max?: number;
  now?: number;
}): Promise<RoutingRepairResult> {
  const candidates = await listNonRoutableSkills(params.storeOpts ?? {});
  const roots = resolveStorageRoots(
    params.storeOpts?.configDir ? { configDir: params.storeOpts.configDir } : {},
  );
  const outcomes: RoutingRepairOutcome[] = [];
  let llmCalls = 0;
  let rewrites = 0;
  const max = params.max ?? DEFAULT_MAX_REWRITES_PER_PASS;
  for (const c of candidates) {
    if (rewrites >= max) {
      outcomes.push({
        name: c.name,
        outcome: "skipped",
        from: c.description,
        reason: `per-pass cap (${max}) reached`,
      });
      continue;
    }
    // Fresh index per skill so a rewrite just applied counts for overlap.
    const liveIndex = await listLiveSkillIndex(roots);
    const r = await repairSkillRouting({
      llmCall: params.llmCall,
      name: c.name,
      ...(params.storeOpts ? { storeOpts: params.storeOpts } : {}),
      liveIndex,
      ...(params.now !== undefined ? { now: params.now } : {}),
    });
    llmCalls += r.llmCalls;
    outcomes.push(r.outcome);
    if (r.outcome.outcome === "rewritten") {
      rewrites += 1;
    }
  }
  return { examined: candidates.length, candidates, outcomes, llmCalls };
}
