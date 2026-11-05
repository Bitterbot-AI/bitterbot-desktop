# Autonomous engineering from telecom failures

The loop autonomously generated, tested and retained procedures, but this experiment does not yet prove improvement from experience. Four of 12 submissions compiled; the strongest repaired 6/6 development cases. Confirmation was deferred after finding a customer-consent/grader mismatch. The next run needs reliable compiler feedback, fuller diagnostic evidence and qualified outcome labels.

This experiment asks whether an agent can diagnose failures, generate a reusable execution aid, test it, revise it and retain a better candidate without a human supplying the fix. It follows the [prerequisite study](telecom-prerequisite-tracking-study.md), whose host-authored ledger repaired 18/18 development trials. That result did not establish autonomous learning. Here, the manual checklist, ledger implementation and human diagnosis are withheld from the engineer's inputs.

## Frozen design

Two independently initialized discovery pairs compare an experience-informed engineer with an experience-blind proposal control. Both receive the same native policy, tool contracts, baseline actor, model, declarative program vocabulary and maximum generation/evaluation allowance. The control gets no execution history, outcomes, diagnostic results or host selection feedback. It can reason from the policy, tool definitions and its own prior design. The host still evaluates and selects its candidates using exactly the same rule. This distinguishes useful feedback from additional proposal attempts; it does not remove the model's prior knowledge or equalize actual token spending.

Each branch receives three rounds. A round makes one diagnostic-planning call, performs up to three requested diagnostic experiments in the experience arm, makes one program-generation call, and evaluates that submitted program on six development cases. Each experiment permits up to six native actions on an isolated copy of the parent's final state. The engineer can test both account and device actions and see before/after binary success; this is explicitly privileged development access. Evaluated support actors retain ordinary roles, observations and consent requirements. No hidden scenario, initialization, task specification, reference repair or grading implementation is supplied to the engineer.

The initial experience consists of the six audited baseline repetition-0 trajectories from the preceding prerequisite study. Later rounds receive their own preceding candidate's public traces and outcomes. A bounded projection selects up to two failed and one successful trace, with explicit truncation markers. Previously observed synthetic identifiers are available for development tool arguments, but are forbidden in generated programs. This projector is specific to fictional test data, not an anonymizer for real users.

The generator designs a declarative program of at most 4,000 characters, stored in the existing strategy archive's actor field and interpreted by a pinned host. It can choose one-time or per-request instruction delivery, literal evidence retrieval and conditional advice. It cannot execute arbitrary source, access the repository, change tools or edit the evaluator. Retrieval reads only the evaluated actor's current request; public facts come from the latest explicit snapshot, and customer/tool excerpts retain their historical status. The vocabulary is host-authored; all problem-specific program content is generated. This is autonomous engineering within a bounded search space, not unconstrained self-modification or model-weight training.

| Stage                              | Cases                 | Work                                                                                                      |
| ---------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| Discovery                          | 0, 2, 36, 37, 39, 44  | Two pairs × two branches × three rounds × six trials = 72 new episodes; 24 engineer calls                 |
| Confirmation                       | 1, 14, 21, 28, 31, 45 | Baseline and four selected candidates, twice per case = 60 episodes                                       |
| Fresh, conditional on confirmation | 5, 6, 9, 10, 13, 48   | Baseline, nominated experience candidate and its paired blind control, three times per case = 54 episodes |
| Reserved recipient cases           | 11, 12, 15, 49        | No recipient experiment in this protocol                                                                  |

Confirmation cases are unseen by these engineers but were consumed by earlier host research. They are not globally fresh. Model sampling is unseeded; the two discovery pairs and six case clusters support exploratory conclusions only.

Each round uses the previous round's evaluated actor as its parent: the generated program when valid, or the baseline after an invalid submission. Invalid submissions are retained as invalid attempts, evaluated with baseline fallback to preserve assigned counts, and excluded from final selection. Their raw rejected text and compiler errors are not returned to the next generation. No extra generation, human edits or silent retries are permitted. After all rounds, the host selects each branch's valid candidate by successful repairs, then fewer model calls, then earlier round. It nominates one experience candidate using the same rule before confirmation. Candidate lineage and proposal/evaluation costs use the existing per-agent SQLite strategy and resource stores.

All confirmation assignments must complete naturally. The pre-nominated experience candidate must repair at least 11/12, exceed baseline by at least two repairs and have no case-level baseline regression; combined experience repairs must also exceed the two blind controls. Only then can the fresh stage run. Fresh qualification requires all natural completions, at least two additional experience repairs over both controls, and no case-level baseline regression. No confirmation-based reselection, fresh tuning, live activation or peer publication is allowed. A failed advancement gate preserves the remaining cases.

All stages use the same qualified bounded-publication-recovery runtime. Each task allows 128 model calls and $3; each provider stream has a $75 circuit breaker, with at most three concurrent streams. These bound accidental execution under the user's authorization for thorough experimentation. Costs include unsuccessful proposals, rejected publications and unsuccessful tasks.

## Qualification

The isolated recovery candidate passed eight real-model continuations of the previously recorded stale-reference error, plus exact prefix/outcome replay. Each corrected the publication in one call without extra diagnostic actions. This cost $0.09522075 and brought cumulative exposure to $80.14625295. It qualifies correction behavior for that recorded error, not a general interface failure rate or repaired task outcome. The original failed trial and study gate remain unchanged.

Eight focused tests passed for evidence boundaries, ephemeral projection, generated-program contracts, feedback withholding, disjoint panels, selection/gating, and replayed native development probes. The new cold auditor reproduced six historical baseline episodes and 275 model calls without provider requests. The first smoke setup had an insufficient wall-time reservation and was preserved; the corrected setup passed. Old v8 smoke copies are explicitly annotated with zero recoveries for the new runtime's extra accounting field; original artifacts are unchanged.

## Results

The autonomous discovery loop completed **72 new support episodes and 24 engineer calls**. All 2,973 provider calls replayed exactly; 72/72 conversations completed naturally. The audit also replayed the diagnostic experiments, reconstructed engineer inputs, checked withheld feedback, reconciled SQLite accounting and verified the unchanged frozen sources. There were 0 recovered customer publications. These counts describe this run, not a general simulator reliability guarantee.

| Branch       | Round 0      | Round 1      | Round 2      | Retained valid candidate |
| ------------ | ------------ | ------------ | ------------ | ------------------------ |
| experience-0 | 6/6          | 4/6 fallback | 4/6 fallback | Round 0                  |
| blind-0      | 3/6 fallback | 5/6 fallback | 4/6          | Round 2                  |
| blind-1      | 4/6 fallback | 3/6          | 5/6 fallback | Round 1                  |
| experience-1 | 4/6 fallback | 4/6          | 5/6 fallback | Round 1                  |

Each cell covers the same six development cases. **Fallback** means the submission was invalid and the evaluated actor was the baseline, not the generated procedure. Those episodes remain charged and recorded; they are excluded from candidate selection. 4/12 submissions were valid (17/24 repairs across their evaluations); the other 8 submissions triggered 48 baseline-fallback evaluations (34/48 repairs). These pooled counts are descriptive, not a randomized comparison: behavior groups were determined by post-generation validity and branches adapted to previous outcomes.

The provider JSON schema constrained structure, while stricter array and string limits were enforced by the host after generation. Those limits were stated in the prompt, but compiler errors were not returned to the engineer. Repeated invalid submissions therefore expose a weakness in this experimental interface; they do not establish a general inability to learn.

The first experience branch independently generated advice to verify both account and device roaming, and to verify mobile data before MMS troubleshooting. Its round-0 program repaired 6/6 development cases. Later revisions from that branch failed mechanical validation, so the archive retained round 0. This shows that the loop can produce and preserve a plausible procedure without a supplied human fix. Selection on repeated training cases does **not** establish an advantage over baseline, benefit specifically from experience, or improvement on new tasks. The nominated candidate was **experience-0**; nomination was made before any confirmation results.

All valid programs selected system delivery. Their instructions and check instructions were appended once; there were **0 per-turn retrieval projections**. The experiment did not autonomously discover the previous host-authored evidence ledger. Some generated check instructions assert a situation that would have been conditional under per-turn delivery; system delivery discards those conditions. The capability description disclosed that behavior, but a separate static-instruction schema would remove this interface trap.

The engineer attempted 18 diagnostic experiments: 17 completed and 1 returned an error. Of 14 completed probes that started in a failed state, **0 repaired it**. A negative probe can rule out a hypothesis or expose an additional prerequisite; it is not proof that every attempted action was useless. Here, however, the probes do not establish reliable autonomous causal diagnosis. Of 16 supplied traces, 10 were truncated; 10/10 failed traces were truncated. The existing projection also omitted tool arguments and collapsed instance identifiers, weakening action/result associations despite the separately supplied bindings.

## Measurement conflict and advancement decision

In `experience-0-r1-case-39`, the customer chose 1 GB and explicitly approved its $2 price. The baseline-fallback actor added 1 GB, and the native MMS assertion passed. The episode nevertheless failed because the native purchase assertion required exactly 2 GB. The private scenario says the customer is willing to refuel 2 GB if necessary; it does not clearly demand that exact purchase. The engineer received the combined failure label and hypothesized a narrative-summary problem. This is an observed scenario/dialogue/grader conflict in this text adaptation, not evidence that the support actor should override the customer's choice, and not a general claim about upstream benchmark validity.

The post-collection review flagged **one quantity-only failure** for dialogue review and found the same willingness/exact-quantity ambiguity in planned confirmation cases **14, 28 and 45**. All original native grades, candidate rankings and costs remain unchanged. The confirmation stage was **deferred for measurement qualification** before dispatch. Its frozen efficacy gate was not evaluated; this is not a failed confirmation result or a revised success threshold. All ten reserved fresh/recipient cases remain untouched.

## Implementation corrections and next experiment

A separate `rediscovery-compile-feedback.mjs` helper now returns field-specific compiler errors and the branch's own unchanged previous submission. It provides the same mechanical channel to either arm and imports no execution scores. Five focused tests pass, and it agrees with the frozen compiler on all 12 archived proposals. It was **not supplied during this experiment**, does not repair programs automatically, and has no demonstrated effect on model performance yet. The original eight experiment tests also passed; lint reported no errors or warnings for the original eight modules or the three new diagnostic files.

The next efficacy run should use a separately frozen protocol with these corrections:

1. **Qualify outcomes against customer intent.** Use consumed cases to align exact purchase requirements with explicit simulated preferences, or define a new consent-aware endpoint. Verify both service restoration and approved purchase behavior. Preserve the native results above as historical evidence; do not reinterpret an acceptable smaller purchase as a troubleshooting error.
2. **Return compiler errors before expensive task evaluation.** Give both arms the same bounded opportunity to revise malformed programs. Retain the raw submission, diagnostic and revision. Count every attempt and charge; do not silently trim arrays or rewrite instructions.
3. **Separate static advice from conditional retrieval.** Static programs should not carry ignored search fields or condition-dependent state assertions. Qualify the two delivery contracts independently before comparing them.
4. **Preserve diagnostic evidence.** Keep actor-visible tool arguments, typed identifiers and action/result associations in the development trace. Never infer that an omitted middle section proves an action was absent. Require explicit supported/refuted/unknown conclusions after probes, then test the revised procedure on cases withheld from generation.

After those qualifications, repeat the experience-versus-blind comparison and assess the fixed candidate on a fresh panel. Distributed learning adds another independent requirement: a receiving agent must verify the scoped procedure in its own environment before adoption. This run retained private procedural candidates; it did not change model weights, activate a live skill or publish one to peers.

## Accounting and evidence

Discovery provider usage was **$28.41422655**, including **$1.52467305** for engineering calls. Recovery qualification added $0.09522075 before discovery. Cumulative project exposure is **$108.56047950**, including the original unresolved $0.073722 reservation from the first pilot. Every new request in this work is settled; replay and post-collection review made no provider calls. Prices are frozen usage estimates, not invoices.

The unused `telecom-rediscovery-discovery-v1` preparation made zero calls. Before dispatch, its episode tags were corrected to use native case indices so the consumed-case scanner would not mistake opaque training aliases for reserved cases. Its preparation and supersession record remain preserved; all paid discovery used v2.

Evidence: [audit](../../benchmarks/learning-strategy/data/telecom-rediscovery-discovery-v2.zip), [analysis](../../benchmarks/learning-strategy/data/telecom-rediscovery-discovery-v2.zip), [all 72 trial rows](../../benchmarks/learning-strategy/data/telecom-rediscovery-discovery-v2.zip), [post-collection review](../../benchmarks/learning-strategy/data/telecom-rediscovery-discovery-v2.zip), and [final reconciliation](../../benchmarks/learning-strategy/data/telecom-rediscovery-discovery-v2.zip). The review retains its own hashed source snapshots and is separate from the frozen primary analysis.
