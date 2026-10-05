/**
 * Notices the gateway sends the owner on its own account (PLAN-53 E3, E9): a
 * scheduled job that failed or was turned off, a task stranded by a restart.
 * Every notice is always kept in the main session; these settings govern the
 * extra push to a chat channel.
 */
export type NotificationsConfig = {
  /**
   * Where to push. Without it, notices go where the heartbeat would deliver:
   * its configured target, or the main session's most recent conversation.
   */
  owner?: {
    /** Channel id, for example "telegram" or "whatsapp". */
    channel?: string;
    /** The recipient on that channel. */
    to?: string;
    accountId?: string;
  };
  /**
   * No pushes between `start` and `end` (24-hour "HH:MM"; may run past
   * midnight). Notices raised in that window wait in the main session.
   */
  quietHours?: {
    start?: string;
    end?: string;
    /** IANA timezone. Default: the gateway host's. */
    timezone?: string;
  };
  /** Most pushes in any hour. Default: 6. 0 pushes nothing. */
  maxPerHour?: number;
};
