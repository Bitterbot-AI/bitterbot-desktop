# External Skill Ingestion

Bitterbot can automatically generate skills from external knowledge sources — documentation sites, GitHub repos, PDFs, videos, and more. It uses a **hybrid architecture**:

- a **native TypeScript scraper** that ships with Bitterbot and handles HTML docs + GitHub repos with zero install
- the upstream **[Skill Seekers](https://github.com/yusufkaraaslan/Skill_Seekers)** project by Yusuf Karaaslan (MIT License) as an optional add-on that covers the long tail — PDFs, video transcripts, Jupyter notebooks, Confluence, Notion, OpenAPI specs, and other specialized source types

You get zero-install coverage of the common case and can opt into the full 17+ source type matrix whenever you want. Both paths produce the same signed, TTL-tagged, marketplace-tagged SkillEnvelopes, so downstream consumers don't care which one was used.

---

## Architecture at a glance

```
                         ┌───────────────────────────────────────┐
  Source URL arrives ──▶ │ classifyNativeSource(url)             │
                         │  • github.com/owner/repo  → github    │
                         │  • anything .pdf/.ipynb/  → null      │
                         │  • youtube/vimeo/notion/  → null      │
                         │  • confluence (.atlassian)→ null      │
                         │  • everything else        → docs      │
                         └─────────────┬─────────────────────────┘
                                       │
                ┌──────────────────────┼──────────────────────────┐
                │                      │                          │
                ▼ (native can handle)  ▼ (native can't)           │
        Native TS scraper        Upstream probe:                  │
        • fetchWithSsrFGuard       MCP HTTP → CLI → Python        │
        • Mozilla Readability                                     │
        • GitHub REST API                                         │
                │                      │                          │
                └──────────┬───────────┘                          │
                           ▼                                      │
         SKILL.md + references/ in a temp dir                     │
                           │                                      │
                           ▼                                      │
     Adapter wraps in Ed25519-signed SkillEnvelope                │
     (tagged with transport + TTL + provenance)                   │
                           │                                      │
                           ▼                                      │
           ingestSkill() → quarantine by default                  │
                           │                                      │
                           ▼                                      │
   Execution feedback → trust builds → marketplace listing ───────┘
```

## Source type coverage

| Source                             | Native? | Upstream? | Notes                                                                                                                                           |
| ---------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML documentation sites           | ✓       | ✓         | Native uses Mozilla Readability via our SSRF-hardened fetch. Upstream has richer handling for specific site engines (Docusaurus, GitBook, etc.) |
| GitHub repositories                | ✓       | ✓         | Native pulls README + `docs/*.md` via the GitHub REST API. Upstream clones and walks the full tree.                                             |
| PDFs                               | ✗       | ✓         | Requires the upstream CLI/MCP                                                                                                                   |
| Video transcripts (YouTube, Vimeo) | ✗       | ✓         | Requires the upstream CLI/MCP                                                                                                                   |
| Jupyter notebooks                  | ✗       | ✓         | Requires the upstream CLI/MCP                                                                                                                   |
| OpenAPI specs                      | ✗       | ✓         | Requires the upstream CLI/MCP                                                                                                                   |
| Confluence wikis                   | ✗       | ✓         | Requires the upstream CLI/MCP                                                                                                                   |
| Notion databases                   | ✗       | ✓         | Requires the upstream CLI/MCP                                                                                                                   |
| Local codebases                    | ✗       | ✓         | Requires the upstream CLI/MCP                                                                                                                   |

For the native-covered sources, **no install is required** — the scraper is built into Bitterbot and uses existing infrastructure (web fetch with SSRF protection, Mozilla Readability, `linkedom`).

---

## How it works

Three entry points feed the adapter; all share the same ingestion pipeline:

1. **Background**: The dream engine's exploration mode processes curiosity targets (both `knowledge_gap` and `market_demand`) during idle cycles, respecting `maxSkillsPerCycle` and `maxConcurrentScrapes`.
2. **On-demand**: Agents call the `skill_seekers_ingest` tool mid-session when they encounter an unfamiliar library or API.
3. **Marketplace-driven**: `ingestFromMarketOpportunities()` converts top demand signals into skill-generation targets with revenue attribution.

For every URL processed:

1. `classifyNativeSource()` decides whether native can handle it.
2. If yes, the native scraper runs.
3. If no, the adapter probes upstream transports in order (MCP → CLI → Python module) and dispatches to whichever is available.
4. If neither native nor upstream can serve the URL, the result reports a clear error so the caller knows what's missing.

Every generated skill:

- Gets a valid Ed25519 signature from a per-installation synthetic keypair (persisted in the memory DB).
- Enters the trust pipeline as untrusted (reputation 0.5) and earns promotion through execution success.
- Carries `expires_at` (defaults to 30 days) so memory governance can prune stale auto-generated skills.
- Embeds provenance metadata — source URL, transport used (`native` / `mcp` / `cli` / `python`), marketplace opportunity — for later attribution.

---

## Setup

### Zero-install (native only)

If you only need docs + GitHub coverage, **there is nothing to install**. The native scraper is always available when `skills.skillSeekers.enabled` is not explicitly `false`. The only optional setup is:

- `GITHUB_TOKEN` env var — increases GitHub API rate limits from 60 req/hour (unauthenticated) to 5000 req/hour. Recommended for heavy use.

### Adding upstream for the full source-type matrix

Pick whichever transport fits your deployment:

| Transport           | Best for                                                    | Install                                                                     |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| **MCP HTTP server** | Containerized / remote deployments; multi-tenant hosting    | `pip install skill-seekers[mcp]`, run the server, point `mcpEndpoint` at it |
| **Local CLI**       | Single-user desktop                                         | `pip install skill-seekers`                                                 |
| **Python module**   | Environments where the `skill-seekers` binary isn't on PATH | `pip install skill-seekers` (adapter falls back automatically)              |

The adapter probes upstream transports in order (MCP → CLI → Python) and caches the winner for 5 minutes.

Verify upstream is discoverable:

```bash
skill-seekers --version
```

---

## Configuration

Add to `~/.bitterbot/bitterbot.json`:

```json
{
  "skills": {
    "skillSeekers": {
      "enabled": true,
      "maxSkillsPerCycle": 3,
      "maxConcurrentScrapes": 2,
      "allowedDomains": [],
      "blockedDomains": [],
      "defaultTtlDays": 30,
      "useWebSearchFallback": true,
      "enableMarketplaceDemand": true,
      "mcpEndpoint": null
    }
  }
}
```

| Field                     | Default    | Description                                                                                                                                                |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                 | `true`     | Enable/disable the adapter. Native scraper is enabled alongside; upstream is probed opportunistically.                                                     |
| `maxSkillsPerCycle`       | `3`        | Maximum skills generated per dream cycle. Enforced across direct, gap-fill, and batch paths.                                                               |
| `maxConcurrentScrapes`    | `2`        | Concurrent scrape operations. Used by `ingestBatch()` and `ingestFromMarketOpportunities()`.                                                               |
| `allowedDomains`          | `[]` (all) | Only scrape these domains. Empty = allow all. Enforced on every path, including URLs discovered via web search.                                            |
| `blockedDomains`          | `[]`       | Never scrape these domains.                                                                                                                                |
| `defaultTtlDays`          | `30`       | Auto-generated skills get `expires_at = now + defaultTtlDays` so stale scrapes can be pruned.                                                              |
| `useWebSearchFallback`    | `true`     | When a knowledge gap contains no URL, use the configured web search provider to find an authoritative docs URL. Requires `tools.web.search` to be enabled. |
| `enableMarketplaceDemand` | `true`     | When true, market-demand curiosity targets tag generated envelopes with `marketplace_opportunity` metadata for revenue attribution.                        |
| `mcpEndpoint`             | `null`     | Optional HTTP MCP endpoint URL. When set and reachable, upstream prefers it over the local CLI.                                                            |

If `skills.skillSeekers.enabled` is not explicitly `false`, the adapter activates automatically. The native scraper covers docs + GitHub unconditionally; the upstream probes only matter for URL types native can't handle.

---

## The agent tool: `skill_seekers_ingest`

Agents can trigger scraping mid-session via the `skill_seekers_ingest` tool:

```json
{
  "tool": "skill_seekers_ingest",
  "url": "https://docs.example.com/api",
  "name": "example-api",
  "description": "Official Example API reference",
  "type": "docs"
}
```

The tool:

- Respects the same `maxSkillsPerCycle` budget as the dream engine — burst generation doesn't steal from exploration.
- Enforces `allowedDomains` / `blockedDomains`.
- Returns `budgetRemaining` so the agent can decide whether to continue.
- Reports the transport used (`native`, `mcp`, `cli`, or `python`) for observability.
- Fails gracefully with a clear `error` code when neither native nor upstream can serve the URL.

Useful patterns:

- **"I don't know this library"** — agent calls the tool with the official docs URL, gets a new skill ingested into quarantine, and can use it next session.
- **Pre-emptive learning** — a workflow agent calls the tool at session start to scrape docs for the libraries it expects to touch.

---

## Trust model

Auto-generated skills are **untrusted by default**, regardless of transport. They follow the same trust pipeline as P2P skills:

| Stage            | Trust Level   | Behavior                                                                                                    |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| Ingestion        | 0.5 (neutral) | Quarantined for review (if `ingestPolicy: "review"`) or accepted with low trust (if `ingestPolicy: "auto"`) |
| First executions | 0.5 - 0.7     | Trust builds with successful executions                                                                     |
| Proven           | 0.7+          | Auto-accepted in future, eligible for marketplace                                                           |
| Established      | 0.9+          | Treated like a trusted peer                                                                                 |

The adapter registers a **synthetic peer** (`local-skill-seekers`) with a real Ed25519 keypair generated once per installation and persisted in the memory DB. All envelopes — native and upstream — are signed with the same keypair and pass the same cryptographic verification as P2P skills.

---

## Conflict detection (upstream only)

When the upstream Skill Seekers transport detects discrepancies between documentation and source code (e.g., an API documented but not in the codebase), the adapter creates **epistemic directives** — questions the agent surfaces to the user for resolution.

Only high-severity conflicts generate directives (capped at 2 per ingestion to avoid noise). Directive types:

- `missing_in_code` (high severity) — API documented but doesn't exist
- `signature_mismatch` (medium) — Parameters/types differ between docs and code
- `missing_in_docs` (medium) — API exists in code but isn't documented

The native scraper doesn't currently perform conflict detection (it's a feature unique to the upstream Python implementation). Future roadmap item.

---

## Marketplace demand loop

The integration with marketplace intelligence creates a closed economic loop with revenue attribution:

1. `MarketplaceIntelligence.analyzeOpportunities()` identifies high-demand, low-supply categories based on recent purchases, open bounties, and unfulfilled searches.
2. Either of two paths kicks in:
   - **Indirect**: `injectDemandTargets()` creates curiosity targets of type `market_demand`, and the dream engine's exploration mode picks them up via the same `fillKnowledgeGap` pipeline.
   - **Direct**: `SkillSeekersAdapter.ingestFromMarketOpportunities(resolveUrl)` iterates opportunities and calls a caller-supplied URL resolver — useful for curated allowlists or when the marketplace has a known canonical docs source per category.
3. Generated envelopes are tagged with `marketplace_opportunity` provenance (category, expected revenue, demand score) so downstream analytics can attribute sales back to the originating signal.
4. Skills that pass the quality gate (3+ executions, >70% success rate) become listable for USDC trade.
5. Sales revenue reinforces demand signals for that category — the loop closes.

---

## Transports

### Native TypeScript scraper (always available)

Implemented in `src/memory/skill-seekers-native.ts`. Reuses Bitterbot infrastructure:

- `fetchWithSsrFGuard` — SSRF protection, DNS pinning, timeouts (same guard used by `web_fetch`)
- `@mozilla/readability` via `extractReadableContent` — strips nav/footer/chrome
- `linkedom` — lightweight DOM for HTML parsing
- GitHub REST API with optional `GITHUB_TOKEN` for rate limits

Output format is byte-compatible with upstream Skill Seekers: a directory containing `SKILL.md` with YAML frontmatter plus optional `references/*.md` files. Frontmatter includes `generated_by: bitterbot-native-skill-seekers` and `format_credit` pointing to Yusuf Karaaslan's upstream schema.

### MCP HTTP (optional, preferred upstream)

The adapter expects a POST endpoint at `<mcpEndpoint>/create` accepting JSON:

```json
{
  "url": "https://docs.example.com",
  "target": "claude",
  "name": "optional",
  "description": "optional",
  "type": "docs"
}
```

…returning:

```json
{
  "files": [
    { "path": "SKILL.md", "content": "---\nname: ...\n---\n..." },
    { "path": "references/foo.md", "content": "..." }
  ],
  "conflicts": [...]
}
```

A `GET /health` endpoint is used for the reachability probe.

### Local CLI (optional upstream)

Executes `skill-seekers create <url> --target claude --output <tmpdir> --quiet`. Timeouts at 120 seconds per scrape.

### Python module (optional upstream fallback)

Falls back to `python3 -m skill_seekers create ...` if the `skill-seekers` binary isn't on PATH but the Python package is installed.

---

## Attribution

The **upstream** Skill Seekers project ([https://github.com/yusufkaraaslan/Skill_Seekers](https://github.com/yusufkaraaslan/Skill_Seekers)) is created by [Yusuf Karaaslan](https://github.com/yusufkaraaslan) and licensed under the MIT License. The 17+ source-type matrix, conflict detection, and the SKILL.md output format are all his work.

Bitterbot's **native scraper** is an independent TypeScript implementation that:

- Targets the same SKILL.md output format so either path produces interchangeable skills.
- Covers only HTML docs and GitHub repos — the most common case — using our existing infrastructure.
- Credits the upstream format designer in the generated frontmatter (`format_credit` field).
- Defers to the upstream CLI/MCP/Python transports for source types it can't handle.

The hybrid design means Bitterbot works zero-install for 70-80% of use cases while still integrating cleanly with the upstream project for the long tail. All credit for the original scraper and format design belongs upstream.
