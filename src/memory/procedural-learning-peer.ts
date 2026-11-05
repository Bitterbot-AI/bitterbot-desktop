import type { SkillEnvelope } from "../agents/skills/ingest.js";
import type { ProceduralLearningStore } from "./procedural-learning-store.js";
import { validateSkillEnvelope } from "../agents/skills/envelope-validation.js";
import { LearningCandidateSchema, learningHash } from "./procedural-learning-contract.js";

export const LEARNING_PACKET_MARKER = "bitterbot-procedural-learning-v1";

/** Payload lives inside the SIGNED bytes, never unsigned envelope provenance. */
export function exportLearningPacket(store: ProceduralLearningStore, hash: string): string {
  const entry = store.get(hash);
  if (
    !entry ||
    entry.state !== "verified" ||
    !store.usable(hash) ||
    entry.candidate.sharing !== "shareable"
  )
    throw new Error("Procedure is not shareable and locally verified");
  const ancestors = store.db
    .prepare(`WITH RECURSIVE ancestors(hash) AS (SELECT ? UNION
    SELECT p.parent FROM learning_parents p JOIN ancestors a ON p.child=a.hash) SELECT hash FROM ancestors`)
    .all(hash) as { hash: string }[];
  for (const ancestor of ancestors) {
    const parent = store.get(ancestor.hash);
    if (!parent || parent.candidate.sharing !== "shareable")
      throw new Error("Private or missing ancestry");
    for (const id of parent.candidate.sourceEpisodes)
      if (store.episode(id)?.sharing !== "shareable")
        throw new Error("Source sharing permission missing");
  }
  const payload = Buffer.from(
    JSON.stringify({ hash, candidate: entry.candidate }),
    "utf8",
  ).toString("base64");
  return `---\nname: verified-procedure-${hash.slice(0, 12)}\ndescription: Quarantined procedural learning candidate\n---\n<!-- ${LEARNING_PACKET_MARKER}:${payload} -->\n`;
}

export function importLearningPacket(
  store: ProceduralLearningStore,
  envelope: SkillEnvelope,
): string {
  if (envelope.skill_md.length > 80000) throw new Error("Learning packet too large");
  const error = validateSkillEnvelope(envelope);
  if (error) throw new Error(error);
  const content = Buffer.from(envelope.skill_md, "base64").toString("utf8");
  if (content.length > 60000) throw new Error("Learning packet too large");
  const matches = [
    ...content.matchAll(/<!-- bitterbot-procedural-learning-v1:([A-Za-z0-9+/=]+) -->/g),
  ];
  if (matches.length !== 1) throw new Error("Invalid learning packet");
  const packet = JSON.parse(Buffer.from(matches[0][1], "base64").toString("utf8")) as {
    hash?: unknown;
    candidate?: unknown;
  };
  const candidate = LearningCandidateSchema.parse(packet.candidate);
  if (packet.hash !== learningHash(candidate)) throw new Error("Learning packet hash mismatch");
  // Remote verification and reputation never substitute for local verification.
  const entry = store.propose(candidate, true);
  store.audit("peer-source", `${entry.hash}:${envelope.author_pubkey}`);
  return entry.hash;
}
