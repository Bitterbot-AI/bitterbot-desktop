---
title: "Verified collective learning"
summary: "Opt-in complete skill packages, local execution checks, and scoped sharing"
---

# Verified collective learning

Bitterbot can stage a complete skill package, transfer its exact bytes, and independently check it before activation. Instructions, helper scripts, references, templates and assets share one immutable package hash. Editing any included file creates a different version and invalidates the earlier version's qualification.

The feature is experimental and disabled by default. Installation does not authorize sharing, paid validation, setup commands or new capabilities. Enable it explicitly in your existing configuration:

```json
{
  "skills": {
    "collective": {
      "enabled": true,
      "publicMesh": false,
      "synthesis": "off",
      "validationModel": "YOUR_PROVIDER/YOUR_MODEL",
      "budget": { "providerUsd": 0, "toolCalls": 2000, "wallMs": 3600000 }
    }
  }
}
```

Restart the gateway after changing worker or mesh configuration. Paid jobs wait until an operator configures a sufficient cumulative budget. Unknown charges retain their reservations. Validation also requires a prepared, compatible Docker image; evaluation does not install it or run package setup commands.

## Stage, inspect and validate

Open **Skills** in a Circle header. The catalog shows exact files, differences, requirements, source evidence, local evidence, costs and reasons for waiting. Stage a local package and request validation through the catalog or the `skills.packages.*` gateway methods. The bundled research-brief fixture demonstrates a complete package. Other domains require a trusted host execution/checker integration.

Packages pass static screening and a separate execution gate. Candidate and incumbent receive the same resettable tasks and limits, with host-owned checkers outside the sandbox. Promotion requires verified candidate use, settled costs, at least 20 paired selection tasks, a positive success delta at the allocated significance threshold, and no new fixed-panel failures. A successful candidate enters a deterministic 50% canary; 20 checked exposed runs without a confirmed regression are required for stability. Insufficient evidence remains staged or incomplete.

Runs pin immutable versions so an update cannot mix old instructions with new helpers. Pin or fork a customized package before updating. Automatic adoption cannot overwrite a pinned or customized version. Confirmed regressions disable the candidate and restore a compatible prior version; environment changes make qualification stale. The audit history remains available.

## Grant sharing separately

Only an operator with `operator.approvals` can create or change automation grants. Select a destination, agents, publishers, skill lineages, disclosure categories, allowed capabilities, expiry and budget. Publication, evidence sharing, incoming evaluation and update adoption are independent operations. Agent tools may request work but cannot grant themselves authority or create verdicts.

Circle membership, visibility, package hash, policy and budget are checked at execution and object retrieval. Revoking a grant stops subsequent authorized work; already sent requests or copies cannot be erased. Public publication requires a separate public grant and `publicMesh`; Circle permission never authorizes it. Generated research briefs retain their draft/review flow.

Public package discovery and object transfer also require a sidecar built from the new package-protocol source. Orchestrator 0.2.5 is the first sidecar with that protocol; v0.2.4, bundled with application releases up to and including 1.14.0, refuses the package topic. On those releases leave `publicMesh` disabled and use the private authenticated RPC transport or offline import/export. A gateway paired with an older sidecar logs `Complete package mesh unavailable` at start and neither sends nor receives packages or skill cards. An older peer cannot receive a partial package through a legacy fallback.

Structured peer evidence is stored separately from conversational memory. It may guide bounded proposals but cannot qualify a package locally. Start synthesis in `shadow` when explicitly permitted; `off` stops new proposals. Every proposed update returns through the same execution gate. Hermes imports likewise enter quarantine and local validation; external traces remain observations unless independently verified by a trusted host.

## Evidence and limits

An exploratory DOCX pilot found cheaper, faster execution with a repaired helper and reuse in an isolated recipient. It used a small authored corpus on one physical host, and its original endpoint remained incomplete because of an interrupted baseline run. It does not establish broad collective-learning efficacy or activate the example package in production.

The repository includes [data, methodology and offline artifact replay](https://github.com/Bitterbot-AI/bitterbot-desktop/tree/main/benchmarks/collective-learning/published/executable-learning-20261114), including negative observations and further experiments. The current production gate requires success improvement; an efficiency-only qualification path is future design work.

## Next release preparation

The application feature remains opt-in with zero-dollar defaults. Before advertising public-mesh package support in a binary release, publish the updated Rust sidecar through the existing signed `orchestrator-release.yml` workflow, advance both Cargo version records and the application's sidecar pin, and verify packaged binaries against two isolated nodes. The protected release environment retains its existing maintainer approval. Merging the application source does not replace already published sidecar binaries.
