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
  /** Max concurrent scrape operations. Default: 1. */
  maxConcurrentScrapes?: number;
  /** Allowed source domains (empty = allow all). */
  allowedDomains?: string[];
  /** Blocked source domains. */
  blockedDomains?: string[];
  /** TTL in days for auto-generated skills. Default: 30. */
  defaultTtlDays?: number;
};
