# External Skill Ingestion

Bitterbot can automatically generate skills from external knowledge sources — documentation sites, GitHub repos, PDFs, videos, and more — using [Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) by Yusuf Karaaslan (MIT License).

This is an **optional integration**. Bitterbot works fully without it. When available, it adds an automated pipeline that fills knowledge gaps detected by the Curiosity Engine with real-world documentation, flowing through the same trust and quality gates as any P2P skill.

---

## How It Works

```
Somatic Markers (stress/failure)
        |
        v
Curiosity Engine (knowledge gap detected)
        |
        v
Dream Engine — exploration mode
        |
        v
Skill Seekers Adapter (scrape external docs)
        |
        v
ingestSkill() — enters as untrusted (quarantined)
        |
        v
Execution feedback — success/failure builds trust
        |
        v
Skill Refiner (dream mutation merges with experience)
        |
        v
Marketplace listing (if quality gates pass)
```

1. **Gap detection** — The Curiosity Engine identifies knowledge gaps from failed searches, task errors, or marketplace demand signals.
2. **Dream exploration** — During idle dream cycles, the exploration mode checks for unresolved gaps that contain URLs.
3. **External scraping** — The Skill Seekers adapter runs `skill-seekers create <url> --target claude` to convert the source into a structured SKILL.md.
4. **Ingestion** — The output is wrapped in a `SkillEnvelope` with a valid Ed25519 signature and fed through `ingestSkill()`. The skill enters as untrusted (synthetic peer reputation starts at 0.5).
5. **Conflict detection** — If Skill Seekers detects conflicts between documentation and code, they become epistemic directives surfaced to the user.
6. **Trust building** — As auto-generated skills are executed and succeed, the synthetic peer's reputation rises, eventually enabling auto-acceptance.
7. **Refinement** — The Dream Engine's mutation mode can merge external knowledge with experiential patterns — producing "book-smart + street-smart" hybrid skills.
8. **Marketplace** — Skills that pass the quality gate (3+ executions, >70% success rate) become listable for USDC trade.

---

## Setup

### Install Skill Seekers

```bash
pip install skill-seekers
```

Or with MCP server support:

```bash
pip install skill-seekers[mcp]
```

Verify installation:

```bash
skill-seekers --version
```

### Configuration

Add to `~/.bitterbot/bitterbot.json`:

```json
{
  "skills": {
    "skillSeekers": {
      "enabled": true,
      "maxSkillsPerCycle": 3,
      "allowedDomains": [],
      "blockedDomains": [],
      "defaultTtlDays": 30
    }
  }
}
```

| Field                  | Default    | Description                                                                            |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `enabled`              | `true`     | Enable/disable the adapter. Skills generation only runs if the CLI is also installed.  |
| `maxSkillsPerCycle`    | `3`        | Maximum skills generated per dream cycle. Prevents resource abuse during idle periods. |
| `maxConcurrentScrapes` | `1`        | Concurrent scrape operations.                                                          |
| `allowedDomains`       | `[]` (all) | Only scrape these domains. Empty = allow all.                                          |
| `blockedDomains`       | `[]`       | Never scrape these domains.                                                            |
| `defaultTtlDays`       | `30`       | Auto-generated skills expire after this many days if unused.                           |

### No Configuration Needed

If Skill Seekers is installed and the `skills.skillSeekers.enabled` flag is not explicitly `false`, the adapter activates automatically. If the CLI is not on PATH, everything degrades gracefully — no errors, no config changes needed.

---

## Trust Model

Auto-generated skills are **untrusted by default**. They follow the same trust pipeline as P2P skills:

| Stage            | Trust Level   | Behavior                                                                                                    |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| Ingestion        | 0.5 (neutral) | Quarantined for review (if `ingestPolicy: "review"`) or accepted with low trust (if `ingestPolicy: "auto"`) |
| First executions | 0.5 - 0.7     | Trust builds with successful executions                                                                     |
| Proven           | 0.7+          | Auto-accepted in future, eligible for marketplace                                                           |
| Established      | 0.9+          | Treated like a trusted peer                                                                                 |

The adapter registers a **synthetic peer** with a real Ed25519 keypair (generated per installation, persisted in the database). All envelopes are properly signed and pass the same cryptographic verification as P2P skills.

---

## Conflict Detection

When Skill Seekers detects discrepancies between documentation and source code (e.g., an API documented but not in the codebase), the adapter creates **epistemic directives** — questions the agent surfaces to the user for resolution.

Only high-severity conflicts generate directives (capped at 2 per ingestion to avoid noise). Directive types:

- `missing_in_code` (high severity) — API documented but doesn't exist
- `signature_mismatch` (medium) — Parameters/types differ between docs and code
- `missing_in_docs` (medium) — API exists in code but isn't documented

---

## Supported Source Types

Skill Seekers supports 17+ source types. The adapter passes the URL directly to the CLI, which auto-detects the source type:

- Documentation websites (Docusaurus, GitBook, ReadTheDocs, any HTML)
- GitHub repositories
- PDF documents
- Video transcripts (YouTube, Vimeo)
- Jupyter notebooks
- OpenAPI specifications
- Confluence wikis
- Notion databases
- Local codebases
- And more

---

## Marketplace Demand Loop

The integration with marketplace intelligence creates a closed economic loop:

1. `MarketplaceIntelligence.analyzeOpportunities()` identifies high-demand, low-supply categories
2. `injectDemandTargets()` creates curiosity targets of type `market_demand`
3. Dream exploration picks up these targets and calls the Skill Seekers adapter
4. Generated skills flow through quality gates to marketplace listing
5. Sales revenue reinforces demand signals for that category

---

## Attribution

[Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers) is created by [Yusuf Karaaslan](https://github.com/yusufkaraaslan) and licensed under the MIT License. Bitterbot's integration is a thin adapter wrapper — Skill Seekers remains an independent project.
