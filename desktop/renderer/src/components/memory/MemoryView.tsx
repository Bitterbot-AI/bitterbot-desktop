import { Download, Pencil, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useConfirm } from "../ui/confirm-dialog";

export type MemorySummary = {
  id: string;
  kind: "own" | "file";
  editable: boolean;
  source: string;
  semanticType: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  path: string | null;
  preview: string;
};

type MemoryDetail = MemorySummary & { text: string; sensitivity: string | null };
type Fact = {
  key: string;
  value: string;
  statement: string;
  category: string;
  source: string;
  status?: string;
};
type Preference = { category: string; key: string; value: string };
type AuditEntry = { id: string; event: string; actor: string; timestamp: number };

const AUDIT_WORDS: Record<string, string> = {
  owner_forget: "You deleted a memory",
  owner_edit: "You corrected a memory",
  owner_retire_fact: "You retired a settled fact",
  owner_unretire_fact: "You brought a retired fact back",
  owner_pin_fact: "You pinned a settled fact",
  forgotten: "Faded out (not used in a long time)",
  expired: "Expired (its keep-until date passed)",
  merged: "Merged into a similar memory",
  consolidated: "Merged into a similar memory",
  archived: "Archived",
  reconsolidation: "Updated after being recalled",
  session_extraction: "Learned from a conversation",
  owner_forget_preference: "You removed something it had learned about you",
  rewrite: "Rewritten while dreaming",
  mutated: "Changed while dreaming",
  imported: "Imported",
  restore: "Restored",
};

/** An audit event, in words; null for internal bookkeeping the owner need not see. */
export function describeAuditEvent(e: { event: string }): string | null {
  return AUDIT_WORDS[e.event] ?? null;
}

/** Where a memory came from, in words. */
export function describeOrigin(m: MemorySummary): string {
  if (m.kind === "own")
    return m.semanticType
      ? `${m.semanticType}, remembered by your agent`
      : "remembered by your agent";
  if (m.source === "sessions") return "from a conversation";
  if (m.source === "skills") return "from a skill";
  return m.path ? `from ${m.path}` : "from a file";
}

/**
 * What the agent remembers, and the owner's say over it (PLAN-53 G1): find,
 * read, correct, forget, export.
 */
export function MemoryView() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [confirm, confirmElement] = useConfirm();
  const [kind, setKind] = useState<"own" | "file">("own");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MemorySummary[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [open, setOpen] = useState<MemoryDetail | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [retired, setRetired] = useState<Fact[]>([]);
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(
    async (more = false) => {
      if (status !== "connected") return;
      try {
        const res = (await request("memory.list", {
          kind,
          q: q.trim() || undefined,
          limit: 50,
          ...(more && cursor !== null ? { cursor } : {}),
        })) as { memories: MemorySummary[]; nextCursor: number | null };
        setItems((prev) => (more ? [...prev, ...res.memories] : res.memories));
        setCursor(res.nextCursor);
        setUnavailable(false);
      } catch {
        setUnavailable(true);
      }
    },
    [status, request, kind, q, cursor],
  );

  const loadSide = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const [f, p] = await Promise.all([
        request("memory.facts", {}) as Promise<{ facts: Fact[] }>,
        request("memory.preferences", {}) as Promise<{ preferences: Preference[] }>,
      ]);
      setFacts(f.facts ?? []);
      setPrefs(p.preferences ?? []);
    } catch {
      // older gateway
    }
    try {
      const r = (await request("memory.facts", { status: "retired" })) as { facts: Fact[] };
      setRetired(r.facts ?? []);
    } catch {
      // older gateway without the status filter
    }
    try {
      const a = (await request("memory.audit", { limit: 100 })) as { entries: AuditEntry[] };
      setAudit((a.entries ?? []).filter((e) => describeAuditEvent(e) !== null));
    } catch {
      // older gateway
    }
  }, [status, request]);

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, kind]);
  useEffect(() => {
    void loadSide();
  }, [loadSide]);

  const show = async (id: string) => {
    try {
      setOpen((await request("memory.get", { id })) as MemoryDetail);
      setDraft(null);
    } catch (err) {
      toast.error("Could not open it", { description: describeError(err) });
    }
  };

  const saveEdit = async () => {
    if (!open || draft === null) return;
    try {
      setOpen((await request("memory.edit", { id: open.id, text: draft })) as MemoryDetail);
      setDraft(null);
      toast.success("Updated");
      void load(false);
    } catch (err) {
      toast.error("Could not update it", { description: describeError(err) });
    }
  };

  const forget = async (m: MemorySummary) => {
    if (
      !(await confirm({
        title: "Forget this memory?",
        description: "It is deleted from your agent's memory and search. This cannot be undone.",
        actionLabel: "Forget",
        destructive: true,
      }))
    )
      return;
    try {
      await request("memory.forget", { id: m.id });
      setItems((list) => list.filter((x) => x.id !== m.id));
      if (open?.id === m.id) setOpen(null);
      toast.success("Forgotten");
    } catch (err) {
      toast.error("Could not forget it", { description: describeError(err) });
    }
  };

  const exportAll = async () => {
    try {
      const res = (await request("memory.export", {})) as { file: string; memories: number };
      toast.success(`Exported ${res.memories} memories`, {
        description: res.file,
        duration: 15_000,
      });
    } catch (err) {
      toast.error("Export failed", { description: describeError(err) });
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Memory</h1>
          <p className="text-sm text-muted-foreground mt-1">
            What your agent remembers. Correct it, forget it, or take a copy.
          </p>
        </div>
        <button
          onClick={() => void exportAll()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20"
        >
          <Download className="w-3.5 h-3.5" />
          Export everything
        </button>
      </div>

      {unavailable && (
        <div className="p-4 text-sm rounded-xl border border-border/20 bg-card/60 text-muted-foreground">
          Memory is not available on this gateway.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(["own", "file"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={cn(
              "px-3 py-1 text-xs rounded-full border",
              kind === k
                ? "bg-brand text-white border-brand"
                : "border-border/30 text-muted-foreground",
            )}
          >
            {k === "own" ? "Remembered by your agent" : "From conversations and files"}
          </button>
        ))}
        <form
          className="flex items-center gap-1 ml-auto"
          onSubmit={(e) => {
            e.preventDefault();
            void load(false);
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find text…"
            aria-label="Find text"
            className="h-8 px-3 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Search"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground"
          >
            <Search className="w-4 h-4" />
          </button>
        </form>
      </div>
      {kind === "file" && (
        <p className="text-xs text-muted-foreground">
          These are rebuilt from your conversations and files, so they are read-only here.
        </p>
      )}

      <ul className="space-y-2" data-testid="memory-list">
        {items.map((m) => (
          <li key={m.id} className="rounded-xl border border-border/20 bg-card/60 p-3">
            <div className="flex items-start gap-3">
              <button onClick={() => void show(m.id)} className="flex-1 min-w-0 text-left">
                <p className="text-sm text-foreground line-clamp-2 break-words">{m.preview}</p>
                <p className="text-2xs text-muted-foreground mt-0.5">
                  {describeOrigin(m)}
                  {m.updatedAt ? ` · ${formatRelativeTime(m.updatedAt)}` : ""}
                </p>
              </button>
              {m.editable && (
                <button
                  onClick={() => void forget(m)}
                  aria-label="Forget"
                  title="Forget"
                  className="p-1.5 rounded text-danger hover:bg-danger/10 flex-shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {open?.id === m.id && (
              <div className="mt-2 pt-2 border-t border-border/20">
                {draft === null ? (
                  <>
                    <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                      {open.text}
                    </p>
                    {open.editable && (
                      <button
                        onClick={() => setDraft(open.text)}
                        className="mt-2 flex items-center gap-1 text-xs text-brand hover:underline"
                      >
                        <Pencil className="w-3 h-3" /> Correct it
                      </button>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={4}
                      aria-label="Memory text"
                      className="w-full px-3 py-2 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => void saveEdit()}
                        className="px-3 py-1 text-xs rounded-lg bg-brand text-white"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setDraft(null)}
                        className="text-xs text-muted-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {cursor !== null && (
        <button onClick={() => void load(true)} className="text-xs text-brand hover:underline">
          Show more
        </button>
      )}
      {!unavailable && items.length === 0 && (
        <div className="p-6 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60">
          Nothing here{q ? " matches" : " yet"}.
        </div>
      )}

      {facts.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Settled facts</h2>
          <p className="text-xs text-muted-foreground">
            What your agent treats as true without looking it up. Retiring one stops that for good:
            the agent cannot bring the same value back on its own. Only you can, from the retired
            list below.
          </p>
          <ul className="space-y-1">
            {facts.map((f) => (
              <li key={f.key} className="flex items-center gap-3 text-sm">
                <span className="flex-1 break-words">{f.statement || `${f.key}: ${f.value}`}</span>
                <button
                  onClick={() =>
                    void request("memory.retireFact", { key: f.key })
                      .then(() => {
                        setFacts((l) => l.filter((x) => x.key !== f.key));
                        setRetired((l) => [{ ...f, status: "owner_retired" }, ...l]);
                      })
                      .catch((err) =>
                        toast.error("Could not retire it", { description: describeError(err) }),
                      )
                  }
                  className="text-xs text-muted-foreground hover:text-danger"
                >
                  Retire
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {retired.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Retired facts</h2>
          <p className="text-xs text-muted-foreground">
            No longer treated as true. Ones you retired stay out until you bring them back here;
            ones that faded out or that the agent retired come back if they are confirmed again.
          </p>
          <ul className="space-y-1">
            {retired.map((f) => (
              <li key={f.key} className="flex items-center gap-3 text-sm">
                <span className="flex-1 break-words text-muted-foreground">
                  {f.statement || `${f.key}: ${f.value}`}
                  {f.status === "owner_retired" ? " (retired by you)" : ""}
                </span>
                <button
                  onClick={() =>
                    void request("memory.unretireFact", { key: f.key })
                      .then(() => {
                        setRetired((l) => l.filter((x) => x.key !== f.key));
                        setFacts((l) => [{ ...f, status: "active" }, ...l]);
                      })
                      .catch((err) =>
                        toast.error("Could not bring it back", { description: describeError(err) }),
                      )
                  }
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Bring back
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {prefs.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">What it has learned about you</h2>
          <ul className="space-y-1">
            {prefs.map((p) => (
              <li key={`${p.category}:${p.key}`} className="flex items-center gap-3 text-sm">
                <span className="flex-1 break-words">
                  <span className="text-muted-foreground">{p.key}:</span> {p.value}
                </span>
                <button
                  onClick={() =>
                    void request("memory.forgetPreference", { category: p.category, key: p.key })
                      .then(() =>
                        setPrefs((l) =>
                          l.filter((x) => !(x.category === p.category && x.key === p.key)),
                        ),
                      )
                      .catch((err) =>
                        toast.error("Could not remove it", { description: describeError(err) }),
                      )
                  }
                  className="text-xs text-muted-foreground hover:text-danger"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {audit.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Recent changes</h2>
          <p className="text-xs text-muted-foreground">
            What happened to memories lately, including what your agent let go of on its own.
          </p>
          <ul className="space-y-1">
            {audit.map((e) => (
              <li key={e.id} className="flex items-center gap-3 text-sm">
                <span className="flex-1">{describeAuditEvent(e)}</span>
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(e.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {confirmElement}
    </div>
  );
}
