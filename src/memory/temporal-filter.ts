/**
 * Bitemporal query helpers for the memory database.
 *
 * Builds SQL WHERE clauses that filter chunks by their temporal validity:
 * - valid_time_start / valid_time_end: when the fact was true in the real world
 * - transaction_time: when the fact was recorded in the system
 *
 * When a fact is superseded (e.g., user changes deployment target from AWS to
 * Azure), the old chunk gets valid_time_end set instead of being deleted. This
 * preserves historical provenance while excluding stale facts from default search.
 */

export type TemporalFilter = {
  /** Only return facts valid at this specific point in time. */
  validAt?: number;
  /** Only return facts valid within this time range. */
  validRange?: { start: number; end: number };
  /** Only return facts as known at this transaction time (time-travel query). */
  asOf?: number;
  /** Exclude superseded facts where valid_time_end IS NOT NULL. Default: true. */
  excludeSuperseded?: boolean;
};

export type TemporalClause = {
  sql: string;
  params: number[];
};

/**
 * Build a SQL WHERE clause fragment for temporal filtering.
 *
 * The returned clause should be appended to an existing WHERE with AND:
 *   `WHERE ... ${clause.sql}`
 *
 * @param filter  Temporal filter options
 * @param alias   Table alias prefix for column references (default: "c")
 * @returns SQL fragment and parameter bindings
 */
export function buildTemporalWhereClause(
  filter: TemporalFilter,
  alias = "c",
): TemporalClause {
  const conditions: string[] = [];
  const params: number[] = [];

  // Default: exclude superseded facts (valid_time_end IS NOT NULL)
  if (filter.excludeSuperseded !== false) {
    conditions.push(`(${alias}.valid_time_end IS NULL)`);
  }

  // Point-in-time validity
  if (filter.validAt != null) {
    conditions.push(
      `(${alias}.valid_time_start IS NULL OR ${alias}.valid_time_start <= ?)`,
    );
    params.push(filter.validAt);
    conditions.push(
      `(${alias}.valid_time_end IS NULL OR ${alias}.valid_time_end > ?)`,
    );
    params.push(filter.validAt);
  }

  // Range validity
  if (filter.validRange) {
    conditions.push(
      `(${alias}.valid_time_start IS NULL OR ${alias}.valid_time_start <= ?)`,
    );
    params.push(filter.validRange.end);
    conditions.push(
      `(${alias}.valid_time_end IS NULL OR ${alias}.valid_time_end > ?)`,
    );
    params.push(filter.validRange.start);
  }

  // Transaction time (as-of query): only facts ingested before this time
  if (filter.asOf != null) {
    conditions.push(
      `(${alias}.transaction_time IS NULL OR ${alias}.transaction_time <= ?)`,
    );
    params.push(filter.asOf);
  }

  if (conditions.length === 0) {
    return { sql: "", params: [] };
  }

  return {
    sql: " AND " + conditions.join(" AND "),
    params,
  };
}

/**
 * Convenience: build a clause that returns only currently-valid facts.
 * This is the default filter for standard search operations.
 */
export function currentFactsOnly(alias = "c"): TemporalClause {
  return buildTemporalWhereClause({ excludeSuperseded: true }, alias);
}
