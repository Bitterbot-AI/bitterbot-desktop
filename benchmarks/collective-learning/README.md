# Verified collective learning

Opt-in complete skill packages, local execution validation, scoped Circle/public transport, and bounded peer-evidence proposals. Legacy scores and peer reports do not confer local qualification. The feature is ported to main's in-tree agent runtime; default paid budgets remain zero.

The [published executable-learning pilot](published/executable-learning-20261114/README.md) contains the measured gains, negative observations, task data, saved artifacts, methodology, portable offline replay, and required follow-up experiments. See [the operator guide](../../docs/agents/collective-learning.md) for deployment behavior.

## Implementation map

| Area                   | Entry points                                                                       | Behavior                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete packages      | `src/agents/skills/collective/{contracts,package,store}.ts`                        | Frozen bytes, canonical manifest, individual file hashes, signed release lineage, immutable package directories, transactional activation and complete rollback.                                                     |
| Local execution        | `validation.ts`, `research-brief.ts`, `execution-context.ts`, `isolated-config.ts` | Paired execution, host-owned checkers, durable reservations, verified instruction reads, significance gate, fixed regression panel, canary and drift checks.                                                         |
| Session selection      | `run-snapshot.ts`, embedded runner `run/attempt.ts`                                | Pin a session to immutable paths; mount only selected packages read-only in sandboxed sessions.                                                                                                                      |
| Circle automation      | `policy.ts`, `service.ts`, `exceptions.ts`, `src/circles/skill-packages.ts`        | Separate publication, evidence, evaluation and adoption grants; operator approval authority; membership checks on both local node and publisher; existing pending-outbound exceptions.                               |
| Catalog                | `desktop/renderer/src/components/circles/SkillCatalog.tsx`                         | Skills dialog in the Circle header, package files/differences, local versus peer evidence, local staging/validation, adoption, pin/fork/replace/reject/rollback/withdraw, persistent grants, costs and waiting jobs. |
| Transport              | `transport.ts`, `mesh.ts`, `orchestrator-bridge.ts`, Rust `swarm/`                 | Signed descriptors, 24 KiB objects, resumable downloads, scoped serving, separate opt-in public topic, capability negotiation, idempotent delivery and author withdrawals.                                           |
| Evidence and proposals | `evidence.ts`, `coordination.ts`, `proposal-host.ts`                               | Separate signed evidence store, deduplication, disclosure inheritance, bounded peer-informed proposals, shadow mode, same execution gate for every proposed update.                                                  |
| External adapters      | `hermes.ts`, `trace-adapter.ts`                                                    | Offline Hermes conversion with pinned contract, exact original bytes and source hash, explicit compatibility reports, observation-only trace normalization.                                                          |
| Comparative study      | `study.ts`, `cli.ts`, `vitest.config.ts`                                           | Four-condition driver contract, pilot sample planning, immutable manifest hashing, cost accounting, family-clustered paired bootstrap, retention/new-user reporting.                                                 |

Paths in the table after the first row are relative to `src/agents/skills/collective/` unless another directory is shown.

## First controlled deployment

Use two independent test nodes with separate device identities and state directories. Join both to a private Circle through the ordinary approved Circle flow. Do not use production public-mesh nodes for the research study.

Merge this configuration into each node's existing configuration, choosing its already configured model. Enabling packages does not grant sharing or spend authority.

```json
{
  "skills": {
    "collective": {
      "enabled": true,
      "publicMesh": false,
      "synthesis": "off",
      "validationModel": "YOUR_EXISTING_PROVIDER/YOUR_EXISTING_MODEL",
      "budget": { "providerUsd": 0, "toolCalls": 2000, "wallMs": 3600000 }
    }
  }
}
```

Restart the gateway after enabling the worker or public mesh. Paid work waits at the zero-dollar default. The operator must separately configure an adequate budget before a paid pilot; an exact zero-cost local model still needs known rates and sufficient tool/time limits. Budgets are durable cumulative ceilings, not per-request allowances. Unknown costs retain reservations and require trusted host reconciliation from actual provider/tool receipts.

The built-in research-brief executor requires a prepared Linux Docker sandbox image. A read-only image inspection pins its digest and architecture; evaluation never invokes the ordinary sandbox's automatic image-install fallback. The scratch container runs with its host owner's numeric user/group IDs on Linux and mounts the package read-only. It does not install dependencies, run package setup commands, or acquire credentials. The operator's global, provider, agent and sandbox tool restrictions remain in effect. The fixture uses Python helpers and also includes a Node helper for the integration harness. Missing infrastructure or compatibility leaves a visible waiting state. Arbitrary task domains require a trusted `PackageExecutionHost`; the built-in checker only measures the specified research-brief task contract.

1. On the author node, stage `test/fixtures/collective-learning/research-brief` using the Circle catalog's local directory field, or call `skills.packages.stage`. For programmatic staging, declare requirements and required helper paths explicitly. The returned package hash and release ID identify the frozen snapshot.
2. Request `skills.packages.validate` with that release ID. The candidate and incumbent use the same resettable source tasks. For first adoption the incumbent has no proposed package. At least 20 selection pairs and the fixed regression panel must complete with settled costs. Positive evidence must pass the one-sided sign test at `0.05 / 2^attempt`; later attempts use fresh selection instances.
3. Adopt the qualified author package and complete its checked canary. The automatic fixture canary runs host-owned tasks; host integrations may report independently checked production runs using `observeCollectiveCanary`. A package's self-check never supplies the host verdict. A statistically inconclusive candidate remains staged; no override manufactures qualification.
4. In each node's Circle catalog, create a persistent grant for the specific agent, publisher and stable skill ID. The author's grant permits publication. The recipient's grant permits evaluation and, independently, adoption. Evidence remains disabled unless separately selected. Grants expire after 30 days in the UI; RPC policies can specify another explicit expiry.
5. A stable author package is announced automatically under its publication grant. The recipient downloads exact bytes, independently validates against its own baseline, and adopts only under its adoption grant. Revoking a grant or removing a member stops subsequent authorized operations and object requests. Running model requests are not retroactively unspent.
6. Pin or fork before customizing. Stage changes as a new immutable local package. An update cannot replace a pinned/customized version automatically. Explicit replacement requires `operator.approvals` and current local qualification. Rollback restores the prior compatible complete package; if none is compatible, the candidate is disabled.
7. Generated briefs continue through the existing private draft and review flow. Sharing the procedure does not authorize publishing its generated output.

Example inspection calls (shell quoting may differ):

```sh
bitterbot gateway call skills.packages.list --params '{}'
bitterbot gateway call skills.packages.jobs --params '{}'
bitterbot gateway call skills.packages.inspect --params '{"packageHash":"EXACT_HASH"}'
bitterbot gateway call skills.packages.validate --params '{"releaseId":"SIGNED_RELEASE_ID"}'
```

`skills.packages.policy.set`, `.policy.revoke`, `.disclosure.allow`, `.replace`, `.export`, and `.withdraw` require `operator.approvals`. Ordinary inspection uses `operator.read`; job requests use `operator.write` and recheck applicable grants during execution. The agent-facing `skill_package` tool exposes proposals/status/permitted requests only. It cannot create grants, submit verdicts, authorize setup, or activate arbitrary versions.

## Storage, isolation and compatibility

Package state lives in the dedicated `collective-skills/state.sqlite` database under Bitterbot's configured state root; bytes live in `collective-skills/packages/<hash>/content`. Additive tables retain releases, jobs, receipts, grants, outboxes, active pointers, canaries, pins, origins and audit history. Generic conversational memory and raw Circle message tables are not evidence sources.

Packages are limited to 10 MiB, 128 files and 16 directory levels. Links, junctions, hard links, special files, unsafe/colliding paths, compiled executables and detected credentials are refused. Cache/dependency directories are reported as omissions. The store caps installed packages at 1,000 and 1 GiB, partial download directories at 32, and peer evidence at 10,000 summaries. Reaching a bound produces waiting/failure rather than unbounded growth. Archive/retention management should preserve session pins and audit records.

Circle and public serving permissions remain separate even for identical file bytes. Circle-derived descendants retain disclosure provenance. An operator must approve the exact package and new destination before crossing that boundary. Author-signed withdrawals stop serving and disable/revalidate local versions; peer regression claims can only trigger investigation. Withdrawal cannot delete remote copies already received.

Existing legacy skill ingestion remains available under its original single-file hash semantics. It does not create package receipts or a qualified managed release, and it cannot replace a managed active pointer. Complete packages refuse legacy peers rather than falling back to a truncated `SKILL.md`.

The execution observer records successful tool-mediated package reads and requires a complete `SKILL.md` read for improvement credit. It is not a kernel-level file-access audit: reads performed inside arbitrary shell subprocesses are not exhaustively attributed. Strict instruction-read credit remains conservative when a skill is read only through a shell command. Hidden checkers are host-owned and unavailable inside the scratch sandbox. Qualitative recommendation usefulness is not certified by the structural/factual checker.

Hermes interoperability is pinned to NousResearch/hermes-collective-wisdom revision `c443c14dbbf3c8a4d90d613a0456911e087e30a7` and its declared gateway schema revision. `test/fixtures/collective-learning/hermes-pin.json` records provenance. Fixtures are locally authored conformance examples, not upstream-authored skills. Imported files retain their original content hash alongside Bitterbot's converted manifest hash. Portable native exports add an explicit Hermes manifest; incompatible runtime/tool assumptions produce a report/error. Setup remains declarative. Normalized external traces retain observation provenance and cannot become local execution receipts.

## Evidence synthesis rollout

Enable evidence sharing separately from packages. Summaries contain host-extracted outcomes, environment/checker identities, cost status and applicability categories. They exclude raw conversations, documents, credentials and held-out regression content. An optional minimal reproduction additionally requires the `minimal-reproduction` disclosure category and a trusted host supplying the permitted fixture.

Start synthesis in `shadow`. Each proposal sees at most 32 summaries from eight origins and 16,000 characters. Two origins, or a locally reproduced failure, are required; each lineage receives at most one attempt per day. The proposal retains evidence IDs and parent provenance. Shadow candidates remain staged. In `active`, applicable evaluation/adoption grants and the complete local gate still apply. Changing synthesis to `off` stops new proposals. Public reputation never provides qualification.

## Study tools and historical measurements

`study.ts` and `cli.ts` define four-condition manifests, budget checks and paired family-clustered analysis. `deployment-driver.ts` adds isolated workers and real package transport. [PILOT.md](PILOT.md) describes that development harness. The top-level calibration drivers remain research tools, not production qualification shortcuts. Some external calibration commands expect separately prepared fixtures in the ignored research workspace; they are not needed for the self-contained published replay.

The original research-brief pilot hit a ceiling and was stopped. A later prompt-oriented comparison did not establish an advantage for pooled evidence. Executable reuse produced a narrower positive result: a repaired DOCX helper reduced recorded model cost locally and after a same-machine recipient transfer. The published brief preserves the original unmet endpoints and the interrupted baseline. No broader efficacy, delayed retention, or human-quality result is claimed.

Run software checks without model calls:

```sh
pnpm exec vitest run --config benchmarks/collective-learning/vitest.config.ts
python -B -X utf8 benchmarks/collective-learning/published/executable-learning-20261114/replay.py
```

Performance measurements belong to their frozen historical runtime. Tests of the release port do not convert those measurements into results on the new runtime. Future paid experiments require their own frozen schedule within the authorized remaining budget.
