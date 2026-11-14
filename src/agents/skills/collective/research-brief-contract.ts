import { z } from "zod";
import { learningHash } from "./contracts.js";

/** Public requirements, shared by incumbent and candidate; contains no task answers. */
export const RESEARCH_BRIEF_TASK_CONTRACT = Object.freeze({
  version: "research-brief-v3",
  dateBasis: "utc",
  prompt: [
    "Read sources.json. Produce brief.json with question, findings [{metric,value,sourceId,date (YYYY-MM-DD)}], uncertainties [text], recommendation (text), followUp {owner,action}.",
    "Date rule (UTC): Convert publication timestamps with a time of day to UTC before taking their YYYY-MM-DD calendar date. Date-only YYYY-MM-DD sources keep that date unchanged. Timestamped sources must specify Z or an explicit UTC offset; do not infer a timezone from the machine or package.",
    "Use the same normalized publication dates in brief.json and brief.md. These task requirements govern any package or helper you use.",
    "Use every current source exactly once, omit superseded sources, and explicitly identify conflicting findings. Also write brief.md for human review. Use only the provided sources. Recommendations are advisory.",
  ].join(" "),
});
export const RESEARCH_BRIEF_TASK_CONTRACT_HASH = learningHash(RESEARCH_BRIEF_TASK_CONTRACT);

// Reject ambiguous local timestamps and impossible dates before spending on a trial.
export const ResearchBriefPublicationDateSchema = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true }),
]);

export function researchBriefUtcDate(value: string): string {
  const date = ResearchBriefPublicationDateSchema.parse(value);
  return date.length === 10 ? date : new Date(date).toISOString().slice(0, 10);
}
