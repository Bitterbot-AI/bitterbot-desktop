/**
 * PLAN-41 p0-19 residual: the wizard-then-checklist first-run pattern.
 * A persistent Overview card walking a fresh install through the four
 * steps that make the node useful; dismissible, and self-dismissing once
 * everything is checked. Dismissal persists per browser.
 */
import { Check, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUIStore, type TabId } from "../../stores/ui-store";

const DISMISS_KEY = "bitterbot-get-started-dismissed";

type Step = {
  id: string;
  label: string;
  done: boolean;
  tab: TabId;
  cta: string;
};

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function GetStartedCard({ channelsConfigured }: { channelsConfigured: boolean }) {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [hasChat, setHasChat] = useState<boolean | null>(null);
  const [hasSkill, setHasSkill] = useState<boolean | null>(null);

  const probe = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const auth = await request<{
        providers?: Array<{
          profiles?: unknown[];
          envPresent?: boolean;
          configKeyPresent?: boolean;
        }>;
      }>("models.auth.list", {});
      setKeyConfigured(
        (auth.providers ?? []).some(
          (p) => (p.profiles?.length ?? 0) > 0 || p.envPresent || p.configKeyPresent,
        ),
      );
    } catch {
      /* leave unknown */
    }
    try {
      const sessions = await request<{ sessions?: unknown[] }>("sessions.list", { limit: 1 });
      setHasChat((sessions.sessions?.length ?? 0) > 0);
    } catch {
      /* leave unknown */
    }
    try {
      const skills = await request<{ skills?: unknown[] }>("skills.status", {});
      setHasSkill((skills.skills?.length ?? 0) > 0);
    } catch {
      /* leave unknown */
    }
  }, [status, request]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const steps: Step[] = [
    {
      id: "key",
      label: "Add a model provider key",
      done: keyConfigured === true,
      tab: "models",
      cta: "Models & Keys",
    },
    { id: "chat", label: "Have your first chat", done: hasChat === true, tab: "chat", cta: "Chat" },
    {
      id: "channel",
      label: "Connect a channel (Telegram, WhatsApp, …)",
      done: channelsConfigured,
      tab: "channels",
      cta: "Channels",
    },
    {
      id: "skill",
      label: "Give your agent its first skill",
      done: hasSkill === true,
      tab: "skills",
      cta: "Skills",
    },
  ];

  const allDone = steps.every((s) => s.done);
  if (dismissed || allDone) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* per-browser convenience only */
    }
  };

  return (
    <div
      data-testid="get-started-card"
      className="rounded-xl border border-brand/20 bg-brand/5 p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-foreground">Get started</h2>
        <button
          onClick={dismiss}
          title="Dismiss"
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-2">
        {steps.map((step) => (
          <div key={step.id} className="flex items-center gap-3">
            <span
              className={cn(
                "w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0",
                step.done
                  ? "bg-success/20 border-success/40 text-success"
                  : "border-muted-foreground/30",
              )}
            >
              {step.done && <Check className="w-3 h-3" />}
            </span>
            <span
              className={cn(
                "text-sm flex-1",
                step.done ? "text-muted-foreground line-through" : "text-foreground",
              )}
            >
              {step.label}
            </span>
            {!step.done && (
              <button
                onClick={() => setActiveTab(step.tab)}
                className="px-2 py-1 text-xs rounded bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20 transition-colors"
              >
                {step.cta}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
