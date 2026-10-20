# Soapbox: lessons from Prime Intellect and adjacent systems

Reviewed 2026-10-17 against public primary documentation and repositories. This is a
design review, not a benchmark of those systems or a claim that their hosted services
run the same code as their research releases. The recommendations below are ours.

## Recommendation

Keep Soapbox's Rust execution, admission, isolation and settlement core. Use Bitterbot's
existing identity and P2P transport for discovery and job control. Host established
Python/CUDA engines behind versioned workload adapters. Prioritize independent batches,
evaluations and rollout generation before tightly coupled training or model parallelism.

The useful unit of capacity is a measured, available workload slot: model and runtime
version, memory, throughput, network characteristics, trust policy and availability window.
A connected node count or sum of VRAM does not establish usable cluster capacity.

## What Prime Intellect actually separates

### Compute protocol and admission

Prime's public [protocol repository](https://github.com/PrimeIntellect-ai/protocol) separates
discovery, orchestration, workers, validators and Ethereum contracts. Its
[Rust workspace](https://github.com/PrimeIntellect-ai/protocol/blob/main/Cargo.toml) confirms
those are distinct crates. The [usage guide](https://github.com/PrimeIntellect-ai/protocol/blob/main/docs/usage-guide.md)
includes provider whitelisting and an orchestrator task API: decentralized participation
still has admission and scheduling authority.

The repository was archived on January 27, 2026. Its README also leaves key management
and worker firewall guidance unfinished. Treat it as a useful reference, not a maintained
drop-in network or a security certification. We should retain our existing Bitterbot
identity, transport and Base Sepolia wallet boundary rather than importing another stack.

### Workload structure and heterogeneous capacity

[Prime-DiLoCo](https://github.com/PrimeIntellect-ai/prime-diloco) distinguishes fast local
process groups from elastic global groups. It uses heartbeats, infrequent global
synchronization, compressed communication and checkpoint recovery for joining nodes.
The lesson is to organize compatible groups and reduce cross-Internet communication.
It does not make arbitrary home GPUs equivalent to a single high-bandwidth cluster.

[INTELLECT-2](https://www.primeintellect.ai/blog/intellect-2-release) separates rollout
generation, training and weight distribution. That is a strong fit for intermittent
consumer nodes: many can generate independent samples while a suitably provisioned
trainer consumes accepted results. Its SHARDCAST component transfers weights through
an HTTP tree, separate from control events.

Current [Prime-RL training documentation](https://docs.primeintellect.ai/prime-rl/training)
tracks rollout policy versions, bounds staleness and checkpoints trainer and orchestrator
state separately. For Soapbox, a future rollout adapter needs an immutable model version,
deadline, maximum accepted staleness and resumable artifact references. Late results may
be valid computations yet useless to the current training step; the acceptance and price
terms must say which condition earns payment.

### Verification

[TOPLOC](https://github.com/PrimeIntellect-ai/toploc) commits selected intermediate
activations and compares them with validator recomputation. It tolerates specified
floating-point differences across hardware. The
[original research explanation](https://www.primeintellect.ai/blog/toploc) describes why
verification of a generated sequence can be cheaper than generating it token by token,
and discusses limitations and adversarial prompts. Reported speedups are experimental
results, not guarantees for every workload.

This is not a verification switch for our Ollama embedding endpoint. We would need an
instrumented engine, pinned execution profile and calibrated comparison thresholds.
Keep the current GPU assurance label explicit: shape and runtime evidence from a trusted
operator. Add independent recomputation/replication first; evaluate TOPLOC for a later
token-generation adapter. A model's answer can be factually wrong even when its computation
is faithfully verified.

### Model parallelism and transport

Prime's [Internet inference research](https://www.primeintellect.ai/blog/inference)
explores pipeline parallelism across heterogeneous devices and examines bandwidth,
latency and KV-cache constraints. Its [prime-iroh](https://github.com/PrimeIntellect-ai/prime-iroh)
communication backend combines Rust with Python bindings.

Our inference: keep Bitterbot libp2p for identity, discovery, admission and control.
Benchmark direct artifact/tensor transfer separately before choosing a bulk transport.
Large model weights and tensors should not travel in gossip descriptors or small job RPCs.
Splitting layers can make a model fit; it does not promise faster interactive generation.

### Isolation and product packaging

Prime's current [sandbox documentation](https://docs.primeintellect.ai/sandboxes/overview)
describes disposable microVMs, network controls and explicit lifecycle/resource limits.
This suggests two Soapbox execution tiers: constrained, pinned adapters for the current
Docker pilot; separately validated VM isolation for future arbitrary user code. CPU VM
isolation does not establish GPU passthrough isolation automatically. Operator host
protection and input confidentiality from that operator are different requirements.

## Adjacent systems

| System                                                                                         | Relevant mechanism                                                                                                                                  | Soapbox decision                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Hivemind](https://github.com/learning-at-home/hivemind)                                       | DHT discovery, decentralized averaging and fault-tolerant collaborative computation.                                                                | Borrow expiring, workload-specific discovery and elastic membership concepts; avoid adding a second identity/DHT just to find workers.                                                                            |
| [Petals](https://github.com/bigscience-workshop/petals)                                        | Nodes serve different model blocks; clients compose a distributed model. Its privacy guidance recommends trusted private swarms for sensitive data. | Offer model-parallel pools only after routing, replication, throughput and failure benchmarks. Private access and encrypted transport do not hide inputs from execution hosts.                                    |
| [BOINC replication](https://github.com/BOINC/boinc/wiki/JobReplication)                        | Application-specific validation compares replicated results and forms a quorum.                                                                     | Add a verifier per adapter, numerical tolerance where required, independent operator selection, retry limits and an explicit validation budget. Multiple identities alone do not establish independent operators. |
| [Akash providers and leases](https://akash.network/docs/learn/core-concepts/providers-leases/) | Provider bids, selected leases, escrow and direct provider communication.                                                                           | Separate capacity rental from payment for an accepted result. Keep our Sepolia USDC settlement; define the purchased unit and cancellation/refund rules before paid fan-out.                                      |
| [Akash GPU deployments](https://akash.network/docs/learn/core-concepts/gpu-deployments/)       | Placement and GPU/interconnect attributes distinguish suitable multi-GPU deployments.                                                               | Add measured link and device capabilities to scheduling. Require suitable topology for synchronous training.                                                                                                      |
| [Gensyn REE receipts](https://docs.gensyn.ai/tech/ree/receipts)                                | Receipts bind model/configuration/input/output hashes; validation and re-execution verification are distinct, and versions affect reproducibility.  | Introduce versioned execution receipts and record how each was verified. A self-issued hash or signature is provenance, not independent proof that the job ran correctly.                                         |
| [Gensyn AXL](https://docs.gensyn.ai/tech/agent-exchange-layer/how-it-works)                    | Encrypted messaging is separate from application authorization; routing metadata has a different privacy boundary from payloads.                    | Keep explicit peer admission and disclose observable metadata. Existing Bitterbot transport can serve this role.                                                                                                  |

Replication has real costs: BOINC's [platform paper](https://boinc.berkeley.edu/boinc_a_platform_for_volunteer_computing.pdf)
describes hardware/software equivalence classes for numerical agreement and the capacity
cost of redundant execution. Sampling can lower cost, but collusion, verifier selection
and false rejection rates must be measured before attaching automatic financial penalties.

## What this changes for our roadmap

1. **Finish the mesh pilot.** Signed expiring discovery, explicit peer grants, bounded
   transport, private/collective fan-out, durable intent and visible work history are the
   right first increment. Run the same acceptance flow across physical hosts and NAT/relay
   paths; package independent operator hosting. Do not infer fleet-scale readiness from
   a three-process localhost test.
2. **Measure useful capacity.** Maintain adapter-specific benchmarks and observed
   completion/timeout rates. Record measured RTT/bandwidth, cache locality and availability.
   Treat region as a mutable coarse hint, not part of identity or proof of jurisdiction.
   Replace the global pilot capacity topic with scoped discovery before fleet rollout.
3. **Add receipts and validation.** Bind job/attempt, buyer/operator identities, adapter,
   image/model/input/output digests, limits and timestamps. Record assurance separately:
   operator-reported, buyer-recomputed, replicated-with-tolerance or instrumented validation.
   Test wrong models, changed inputs, fabricated outputs, replay, collusion and honest
   numerical variation. Retain private inputs off gossip and out of public receipts.
4. **Ship evaluations and rollouts.** Start with small, resumable, model-pinned jobs using
   familiar ML engines. Benchmark compatibility with Prime's environment/evaluation tooling
   in a container adapter; no direct integration is implemented yet. Keep checkpoint and
   artifact transfers resumable and content-addressed, with authorized access and quotas.
5. **Extend paid mode deliberately.** A buyer approves one total maximum budget and exact
   per-operator quotes on Base Sepolia. Reserve validation overhead; journal transaction
   intent and finality; recover after interruption; reconcile partial success and refunds.
   Only independently established outcomes should affect economic reputation. Free
   self-dealt work must not manufacture trusted seller standing.
6. **Specialized cooperative clusters.** Offer low-communication training or model pipelines
   on compatible reserved pools after measuring the real network. A training adapter owns
   synchronization, versions and checkpoints; the generic scheduler cannot supply those
   semantics by splitting arbitrary work.

Storage/cache service remains a distinct contract: capacity, placement, encryption,
replicas, availability, retrieval verification, repair, retention and deletion need their
own implementation. A cached model is useful utility but is not durable paid storage.

## Positioning and partnership questions

The most defensible initial offering is measured, interruptible inference/evaluation
capacity from existing agent nodes, plus private and collective compute pools. Additional
CPU utility includes approved evaluation environments and simulation/data-processing
batches. These are product hypotheses to validate, not established revenue or partner demand.

For a compute buyer or aggregator, ask what they will purchase: accepted results, reserved
GPU time, interruptible slots, or a predictable cluster. Establish minimum device/VRAM,
uptime, geography, data policy, verification, cancellation, billing and support requirements.
Request a small benchmark workload and an acceptance criterion before promising capacity.
For a training partner, test rollout/evaluation compatibility first and distinguish those
workers from the tightly coupled trainer allocation.

Compute remains enabled by default. Existing payments remain on Base Sepolia with the
separate Compute wallet. This review introduces no external dependency, payment, new
token, deployment or change to the mainnet wallet.
