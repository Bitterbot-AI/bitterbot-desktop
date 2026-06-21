/**
 * Commerce coordination config — PLAN-26 "Aubaine" agent group-buy layer.
 *
 * Off by default. Gates the offer/intent directory, demand matcher, and
 * non-custodial threshold settlement that implement the `aubaine/v1` open
 * protocol (docs/protocol/aubaine-v1).
 */
export type CommerceConfig = {
  /** Aubaine group-buy coordination. */
  groupbuy?: {
    /** Enable the Aubaine directory / matcher / settlement layer. Default: false. */
    enabled?: boolean;
    /** Coordinator fee in basis points on settled syndicates. Default: 200 (2%). */
    coordinatorFeeBps?: number;
  };
};
