import {
  learningHash,
  lineageId,
  PolicySchema,
  type SkillRelease,
  type SkillSharingPolicy,
} from "./contracts.js";
import type { CollectiveSkillStore } from "./store.js";

export type MembershipCheck = (circleId: string, publisher: string) => boolean;
export class SkillPolicyService {
  constructor(
    readonly store: CollectiveSkillStore,
    readonly member: MembershipCheck,
  ) {}
  /** Called only from an operator.approvals route, never from an agent tool. */
  set(input: unknown): SkillSharingPolicy {
    const policy = PolicySchema.parse(input);
    if (policy.scope.kind === "private")
      throw new Error("Sharing requires an explicit destination");
    this.store.db
      .prepare(
        "INSERT INTO collective_policies VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=revision+1",
      )
      .run(policy.id, JSON.stringify(policy));
    this.store.audit("policy-updated", policy.id);
    return policy;
  }
  list(): SkillSharingPolicy[] {
    return (
      this.store.db.prepare("SELECT body FROM collective_policies").all() as { body: string }[]
    ).map((r) => PolicySchema.parse(JSON.parse(r.body)));
  }
  revoke(id: string): void {
    const policy = this.list().find((p) => p.id === id);
    if (policy) this.set({ ...policy, enabled: false });
  }
  authorize(
    agent: string,
    release: SkillRelease,
    operation: SkillSharingPolicy["operations"][number],
    category: SkillSharingPolicy["categories"][number],
  ): SkillSharingPolicy {
    const pkg = this.store.get(release.packageHash);
    if (!pkg) throw new Error("Unknown package");
    if (release.scope.kind === "circle" && !this.member(release.scope.circleId, release.publisher))
      throw new Error("Publisher is not a current Circle member");
    const found = this.list().find(
      (p) =>
        p.enabled &&
        p.expiresAt > this.store.now() &&
        learningHash(p.scope) === learningHash(release.scope) &&
        p.agents.includes(agent) &&
        p.publishers.includes(release.publisher) &&
        p.skillIds.includes(release.skillId) &&
        (!p.packageHashes || p.packageHashes.includes(release.packageHash)) &&
        p.operations.includes(operation) &&
        p.categories.includes(category) &&
        pkg.manifest.requirements.capabilities.every((c) => p.capabilities.includes(c)),
    );
    if (!found) throw new Error(`Approval required for ${operation}: ${lineageId(release)}`);
    return found;
  }
}
