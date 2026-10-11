/**
 * True when a config file holds nothing but what a first gateway start
 * writes on its own: the generated `gateway.auth` token (container first
 * boot, PLAN-56 Phase 2), the `meta` stamp and the `commands` schema
 * default every write adds. Onboarding treats that as "not set up yet"
 * instead of offering to keep/modify/reset an "existing config". Pass the
 * file's own content (snapshot.resolved), never the defaults-applied config.
 */
export function isFirstBootOnlyConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return true;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "meta" && key !== "commands" && key !== "gateway") {
      return false;
    }
  }
  const gateway = record.gateway;
  if (gateway === undefined) {
    return true;
  }
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    return false;
  }
  return Object.keys(gateway).every((key) => key === "auth");
}
