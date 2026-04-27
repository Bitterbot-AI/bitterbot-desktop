import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/cron");

type FinishedRunEvent = {
  jobId: string;
  status: string;
  durationMs?: number;
  error?: string;
  ts: number;
  trigger?: string;
};

export type CronWebhookConfig = {
  webhook?: string;
  webhookToken?: string;
};

export async function postFinishedRunWebhook(
  cfg: CronWebhookConfig,
  event: FinishedRunEvent,
): Promise<void> {
  const url = typeof cfg.webhook === "string" ? cfg.webhook.trim() : "";
  if (!url) {
    return;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = typeof cfg.webhookToken === "string" ? cfg.webhookToken.trim() : "";
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn(`webhook returned ${res.status} for job ${event.jobId}`);
    }
  } catch (err) {
    log.warn(`webhook delivery failed for job ${event.jobId}: ${formatErr(err)}`);
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
