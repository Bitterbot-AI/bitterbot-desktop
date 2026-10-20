import { useCallback } from "react";
import { toast } from "sonner";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";

type OwnerNotice = { kind?: string; text?: string; ts?: number };

/**
 * Gateway notices for the owner (a scheduled job that failed or was turned
 * off, a task stranded by a restart) as toasts anywhere in the app. They stay
 * until dismissed: these are things that went wrong while nobody was looking.
 * Renders nothing.
 */
export function OwnerNoticeToasts() {
  const onNotice = useCallback((payload: unknown) => {
    const notice = payload as OwnerNotice | null;
    if (!notice || typeof notice.text !== "string" || !notice.text) return;
    const title =
      notice.kind === "cron-disabled"
        ? "A scheduled job was turned off"
        : notice.kind === "cron-error"
          ? "A scheduled job failed"
          : notice.kind === "task-stalled"
            ? "Tasks were interrupted"
            : "Notice from your gateway";
    toast.warning(title, {
      description: notice.text,
      duration: Infinity,
      closeButton: true,
      id: `owner-notice:${notice.kind}:${notice.ts}`,
    });
  }, []);
  useGatewayEvent("owner.notice", onNotice);
  return null;
}
