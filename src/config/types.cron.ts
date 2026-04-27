// Cron scheduler configuration. Used by the gateway-resident cron engine
// (`src/cron/engine.ts`). Disabling via `enabled: false` (or
// `BITTERBOT_SKIP_CRON=1`) prevents the engine from starting.
export type CronConfig = {
  /** Whether the cron engine should run. Default: true. */
  enabled?: boolean;
  /** Override for the jobs.json store path. Default: ~/.bitterbot/cron/jobs.json. */
  store?: string;
  /** Maximum jobs that may be in-flight simultaneously. Default: 1. */
  maxConcurrentRuns?: number;
  /** Optional URL receiving finished-run events for jobs with `notify: true`. */
  webhook?: string;
  /** Optional bearer token sent with webhook deliveries. */
  webhookToken?: string;
};
