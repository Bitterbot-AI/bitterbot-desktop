import { GraduationCap, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";

type Recording = {
  id: string;
  title: string;
  goal: string;
  outcome: string;
  actionCount: number;
  status: "recording" | "stopped" | "failed" | "staged" | "saved";
  createdAt: number;
  reason?: string;
  skillName?: string;
};
type Options = { name: string; description: string; parameters: Record<string, string> };
type Draft = {
  record: Recording;
  options: Options;
  parameters: Array<{ id: string; label: string }>;
  content: string;
};
type Check = { ok: boolean; content: string; hash?: string; summary: string };
const inputClass = "w-full rounded border border-border bg-background px-2 py-1.5 text-xs";
const buttonClass =
  "rounded border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

/** Owner-led teaching lives beside the actual browser, not in a separate editor. */
export function BrowserTeaching({ mine }: { mine: boolean }) {
  const request = useGatewayStore((s) => s.request);
  const connected = useGatewayStore((s) => s.status === "connected");
  const [open, setOpen] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [outcome, setOutcome] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const active = recordings.find((r) => r.status === "recording");

  const refresh = useCallback(async () => {
    const data = await request<{ recordings: Recording[] }>("browser.teaching.list", {});
    setRecordings(data.recordings);
  }, [request]);
  useEffect(() => {
    if (!open || !connected) return;
    let disposed = false;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await request<{ recordings: Recording[] }>("browser.teaching.list", {});
        if (!disposed) setRecordings(data.recordings);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : "Could not load recordings.");
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [open, connected, request]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The demonstration could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const edit = (options: Options) => {
    if (draft) setDraft({ ...draft, options });
    setCheck(null);
    setReviewed(false);
  };
  const review = (id: string) =>
    run(async () => {
      const next = await request<Draft>("browser.teaching.draft", { id });
      setDraft(next);
      setCheck(null);
      setReviewed(false);
    });

  return (
    <div className="border-b border-border/40 shrink-0">
      <button
        type="button"
        className="flex items-center gap-2 px-3 py-2 text-xs text-brand"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <GraduationCap className="h-4 w-4" /> Teach this workflow
        {active && <span className="text-warning">Recording · {active.actionCount} steps</span>}
      </button>
      {open && (
        <section
          aria-label="Teach a browser workflow"
          className="max-h-96 overflow-auto space-y-3 px-3 pb-3"
        >
          <p className="text-xs text-muted-foreground">
            Demonstrate a workflow in this browser. Typed values and images are not recorded. Page
            labels and cleaned URLs stay on the gateway; review them before saving a skill. Using
            the skill sends its instructions to your configured model.
          </p>
          {!connected && (
            <p role="status" className="text-xs">
              Reconnect to the gateway to manage recordings.
            </p>
          )}
          {active ? (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span>
                Recording {active.title} · {active.actionCount} steps · stops after 10 minutes
              </span>
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !connected}
                onClick={() =>
                  void run(async () => {
                    await request("browser.teaching.stop", { id: active.id });
                    const next = await request<Draft>("browser.teaching.draft", { id: active.id });
                    setDraft(next);
                    setCheck(null);
                    setReviewed(false);
                  })
                }
              >
                Stop and review
              </button>
            </div>
          ) : (
            !draft && (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await request("browser.teaching.start", { title, goal, outcome });
                  });
                }}
              >
                <label className="text-xs">
                  Workflow name
                  <input
                    className={inputClass}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    minLength={3}
                    maxLength={100}
                    required
                    placeholder="Find an invoice"
                  />
                </label>
                <label className="text-xs">
                  What are you trying to do?
                  <input
                    className={inputClass}
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    minLength={5}
                    maxLength={500}
                    required
                    placeholder="Find a supplier invoice for a chosen month"
                  />
                </label>
                <label className="text-xs">
                  How will you know it worked?
                  <input
                    className={inputClass}
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                    minLength={5}
                    maxLength={500}
                    required
                    placeholder="The invoice matches the supplier and month"
                  />
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className={buttonClass}
                    disabled={busy || !mine || !connected}
                  >
                    Record demonstration
                  </button>
                  {!mine && (
                    <span className="text-xs text-muted-foreground">
                      Take over the browser to record.
                    </span>
                  )}
                </div>
              </form>
            )
          )}

          {draft && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex justify-between items-center text-sm font-medium">
                Review {draft.record.title}
                <button
                  type="button"
                  aria-label="Close skill draft"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setCheck(null);
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs">Expected result: {draft.record.outcome}</p>
              <label className="block text-xs">
                Skill name
                <input
                  className={inputClass}
                  value={draft.options.name}
                  disabled={busy}
                  onChange={(e) => edit({ ...draft.options, name: e.target.value })}
                />
              </label>
              <label className="block text-xs">
                When to use it, and when not to
                <textarea
                  className={inputClass}
                  rows={2}
                  value={draft.options.description}
                  maxLength={240}
                  disabled={busy}
                  onChange={(e) => edit({ ...draft.options, description: e.target.value })}
                />
              </label>
              {draft.parameters.map((parameter) => (
                <label key={parameter.id} className="block text-xs">
                  Input for {parameter.label}
                  <input
                    className={inputClass}
                    aria-label={`Name for ${parameter.id}`}
                    value={draft.options.parameters[parameter.id] ?? parameter.id}
                    disabled={busy}
                    pattern="[a-z][a-z0-9_]{1,39}"
                    onChange={(e) =>
                      edit({
                        ...draft.options,
                        parameters: { ...draft.options.parameters, [parameter.id]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !connected}
                onClick={() =>
                  void run(async () => {
                    const result = await request<Check>("browser.teaching.stage", {
                      id: draft.record.id,
                      options: draft.options,
                    });
                    setCheck(result);
                    setReviewed(false);
                  })
                }
              >
                Check skill draft
              </button>
              <pre
                aria-label="Generated skill instructions"
                className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs"
              >
                {check?.content ?? draft.content}
              </pre>
              {!check && (
                <p className="text-xs text-muted-foreground">
                  Check the draft to refresh the preview after editing.
                </p>
              )}
              {check && (
                <p role="status" className="text-xs">
                  {check.summary}
                </p>
              )}
              {check?.ok && (
                <>
                  <label className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    I reviewed the instructions and inputs. Save this skill for local use.
                  </label>
                  <p className="text-xs text-muted-foreground">
                    These checks do not prove task success. The skill keeps normal tool permissions
                    and is not automatically shared.
                  </p>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || !reviewed || !connected}
                    onClick={() =>
                      void run(async () => {
                        const result = await request<{ name: string }>(
                          "browser.teaching.activate",
                          { id: draft.record.id, hash: check.hash, reviewed: true },
                        );
                        setMessage(
                          `Saved ${result.name}. Ask your agent to use it with your inputs; it is also available in Skills.`,
                        );
                        setDraft(null);
                        setCheck(null);
                        setReviewed(false);
                      })
                    }
                  >
                    Save local skill
                  </button>
                </>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="text-xs text-success">
              {message}
            </p>
          )}
          {recordings
            .filter((r) => r.status !== "recording")
            .map((r) => (
              <div
                key={r.id}
                className="flex justify-between items-center gap-2 border-t border-border/40 pt-2 text-xs"
              >
                <div>
                  <span>
                    {r.title} · {r.actionCount} steps · {r.status}
                  </span>
                  {r.reason && <p className="text-muted-foreground">{r.reason}</p>}
                </div>
                <div className="flex gap-1">
                  {r.status !== "saved" && r.status !== "failed" && r.actionCount > 0 && (
                    <button
                      className={buttonClass}
                      type="button"
                      disabled={busy || !connected}
                      onClick={() => void review(r.id)}
                    >
                      Review
                    </button>
                  )}
                  <button
                    className={buttonClass}
                    type="button"
                    title={
                      r.status === "saved"
                        ? "Deletes the recording; the saved skill remains in Skills."
                        : "Deletes the recording and its unsaved draft."
                    }
                    disabled={busy || !connected}
                    onClick={() =>
                      void run(async () => {
                        await request("browser.teaching.delete", { id: r.id });
                        if (draft?.record.id === r.id) {
                          setDraft(null);
                          setCheck(null);
                        }
                      })
                    }
                  >
                    Delete recording
                  </button>
                </div>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
