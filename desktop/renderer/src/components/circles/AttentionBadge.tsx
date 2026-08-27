import { cn } from "../../lib/utils";

// The ONE attention pill (Phase D cleanup: this markup was copy-pasted four
// times across the sidebar and the rail, with a drifting clamp). Red = unread,
// amber (consent grammar) = approvals awaiting the human. Renders nothing at
// zero so call sites don't need their own guards.

export function AttentionBadge({
  count,
  tone,
  title,
  className,
}: {
  count: number;
  tone: "unread" | "consent";
  title?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      title={title}
      className={cn(
        "min-w-[16px] h-4 px-1 rounded-full text-badge font-bold grid place-items-center",
        tone === "consent" ? "bg-circle-consent text-circle-consent-fg" : "bg-danger text-white",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** The shared approvals tooltip so the wording can't drift between surfaces. */
export function approvalsTitle(n: number): string {
  return `${n} agent ${n === 1 ? "action needs" : "actions need"} your approval`;
}
