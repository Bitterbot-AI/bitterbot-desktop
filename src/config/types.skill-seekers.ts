/**
 * Configuration for the Skill Seekers adapter.
 *
 * Skill Seekers (https://github.com/yusufkaraaslan/Skill_Seekers) by Yusuf Karaaslan (MIT License)
 * converts 17+ source types into structured AI skills.
 * This adapter wraps its output into Bitterbot's SkillEnvelope format.
 */
export type SkillSeekersConfig = {
  /** Enable the Skill Seekers adapter. Default: true (if CLI is available). */
  enabled?: boolean;
  /** Max skills to generate per dream cycle. Default: 3. */
  maxSkillsPerCycle?: number;
  /** Max concurrent scrape operations. Default: 2. */
  maxConcurrentScrapes?: number;
  /** Allowed source domains (empty = allow all). */
  allowedDomains?: string[];
  /** Blocked source domains. */
  blockedDomains?: string[];
  /** TTL in days for auto-generated skills. Default: 30. */
  defaultTtlDays?: number;
  /**
   * Optional MCP server endpoint (HTTP or stdio command) to use instead of the CLI.
   * Useful for containerized/remote deployments where the Python CLI isn't installed locally.
   */
  mcpEndpoint?: string;
  /**
   * When true, fillKnowledgeGap will use the configured web_search tool to find
   * authoritative docs URLs for gaps that don't contain a URL directly.
   * Requires tools.web.search to be enabled. Default: true when search is enabled.
   */
  useWebSearchFallback?: boolean;
  /**
   * Allow market-demand-driven skill generation. When a curiosity target of
   * type "market_demand" is processed, the adapter tags the resulting envelope
   * with marketplace metadata so revenue can be attributed. Default: true.
   */
  enableMarketplaceDemand?: boolean;
};
