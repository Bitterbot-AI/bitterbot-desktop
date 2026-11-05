import { z } from "zod";
import { validateSkillEnvelope } from "../agents/skills/envelope-validation.js";
import type { SkillEnvelope } from "../agents/skills/ingest.js";
import { LearningStrategySchema } from "./learning-strategy-contract.js";
import type { LearningStrategyLab } from "./learning-strategy.js";
import { learningHash } from "./procedural-learning-contract.js";

export const STRATEGY_PACKET_MARKER = "bitterbot-learning-strategy-v1";
const PacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    target: z.string().regex(/^[a-f0-9]{64}$/),
    strategies: z.array(LearningStrategySchema).min(1).max(64),
  })
  .strict();

/** Transport-ready signed bytes. Source scores are deliberately not qualifications. */
export function exportStrategyPacket(
  lab: LearningStrategyLab,
  hash: string,
  panel: string,
): string {
  lab.archive.requireShadow();
  if (!lab.archive.rank(panel).some((result) => result.strategy === hash))
    throw new Error("Local development evaluation required");
  const seen = new Set<string>(),
    strategies: z.infer<typeof LearningStrategySchema>[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 64) throw new Error("Strategy lineage too large");
    const entry = lab.archive.get(id);
    if (!entry || entry.sharing !== "shareable")
      throw new Error("Private or unavailable strategy ancestry");
    for (const parent of entry.parents) visit(parent);
    strategies.push(entry);
  };
  visit(hash);
  const payload = Buffer.from(
    JSON.stringify({ schemaVersion: 1, target: hash, strategies }),
  ).toString("base64");
  const content = `---\nname: strategy-${hash.slice(0, 12)}\ndescription: Shadow learning strategy; never an active skill\n---\n<!-- ${STRATEGY_PACKET_MARKER}:${payload} -->\n`;
  if (Buffer.byteLength(content) > 100000) throw new Error("Strategy packet too large");
  return content;
}

/** Host-only import, after explicit transport authorization. No remote receipts are trusted. */
export function importStrategyPacket(lab: LearningStrategyLab, envelope: SkillEnvelope): string {
  lab.archive.requireShadow();
  if (envelope.skill_md.length > 140000) throw new Error("Strategy packet too large");
  const error = validateSkillEnvelope(envelope);
  if (error) throw new Error(error);
  const content = Buffer.from(envelope.skill_md, "base64").toString("utf8");
  const matches = [
    ...content.matchAll(/<!-- bitterbot-learning-strategy-v1:([A-Za-z0-9+/=]+) -->/g),
  ];
  if (matches.length !== 1 || Buffer.byteLength(content) > 100000)
    throw new Error("Invalid strategy packet");
  const packet = PacketSchema.parse(
    JSON.parse(Buffer.from(matches[0][1], "base64").toString("utf8")),
  );
  const hashes = new Set(packet.strategies.map(learningHash));
  if (
    hashes.size !== packet.strategies.length ||
    !hashes.has(packet.target) ||
    packet.strategies.some(
      (s) => s.sharing !== "shareable" || s.parents.some((parent) => !hashes.has(parent)),
    )
  )
    throw new Error("Incomplete or private strategy packet");
  // Validate the complete ancestry before writing; rollback partial imports on failure.
  lab.store.db.exec("SAVEPOINT strategy_import");
  try {
    for (const strategy of packet.strategies) lab.archive.add(strategy, "peer");
    lab.store.audit("strategy-peer", `${packet.target}:${envelope.author_pubkey}`);
    lab.store.db.exec("RELEASE strategy_import");
  } catch (error) {
    lab.store.db.exec("ROLLBACK TO strategy_import; RELEASE strategy_import");
    throw error;
  }
  return packet.target;
}
