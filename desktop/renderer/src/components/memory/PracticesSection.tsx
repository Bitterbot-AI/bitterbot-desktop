import { Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { formatDate } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useConfirm } from "../ui/confirm-dialog";

export type PracticeStatus = "candidate" | "active" | "retired" | "suppressed";

export type PracticeRow = {
  id: string;
  statement: string;
  /** `global`, `task:<slug>`, `project:<name>`, `person:<name>` or `job:<id>`. */
  scope: string;
  status: PracticeStatus;
  createdAt: number;
  appliedCount?: number;
  /** The scope in words, from the gateway ("repo stats", "project acme", "everything"). */
  scopeLabel?: string;
  savedAt?: number;
  evidence?: Array<{ ref: string; text: string | null }>;
  counts?: { applied: number; repeats: number; notFollowed?: number };
};

/** A scheduled job a practice can be scoped to. */
export type PracticeJobRow = { scope: string; name: string };

export type TaskTypeRow = {
  slug: string;
  label: string;
  occurrences: number;
  recurring?: boolean;
  example?: string | null;
};

type PracticesResult = {
  practices?: PracticeRow[];
  taskTypes?: TaskTypeRow[];
  activeProject?: string | null;
  jobs?: PracticeJobRow[];
};

const STATUS_WORDS: Record<PracticeStatus, string> = {
  active: "Active",
  candidate: "Waiting for your answer",
  retired: "Retired",
  suppressed: "Declined",
};

const STATUS_ORDER: Record<PracticeStatus, number> = {
  candidate: 0,
  active: 1,
  retired: 2,
  suppressed: 3,
};

/** A practice's status, in words. */
export function describePracticeStatus(status: PracticeStatus): string {
  return STATUS_WORDS[status] ?? status;
}

/** Where a practice applies, in words. The gateway's label wins when it sent one. */
export function describePracticeScope(p: Pick<PracticeRow, "scope" | "scopeLabel">): string {
  if (p.scope === "global") return "Everywhere";
  // The gateway sends the job's name (its id when the job was deleted).
  if (p.scope.startsWith("job:") && p.scopeLabel) return `For the scheduled job ${p.scopeLabel}`;
  if (p.scopeLabel) return `For ${p.scopeLabel}`;
  const name = p.scope.slice(p.scope.indexOf(":") + 1).replace(/-/g, " ");
  if (p.scope.startsWith("project:")) return `For project ${name}`;
  if (p.scope.startsWith("job:")) return "For one scheduled job";
  return `For ${name}`;
}

/** "5 times", "once", "never". */
function times(n: number): string {
  return n === 0 ? "never" : n === 1 ? "once" : `${n} times`;
}

/** What a task type is called: its label, or one of its requests while it has none. */
function taskTypeName(t: TaskTypeRow): string {
  return t.label.trim() || t.example?.trim() || t.slug.replace(/-/g, " ");
}

/** Missing-scope errors read as a sentence, not a protocol string. */
function describeChangeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (raw.toLowerCase().includes("missing scope")) {
    return "This session can look at practices but is not allowed to change them. Open the Control UI with an admin token.";
  }
  return describeError(err);
}

const inputClass =
  "h-8 px-3 text-sm rounded-lg border border-border/30 bg-transparent focus:border-brand focus:outline-none";
const selectClass = "h-8 px-2 text-sm rounded-lg border border-border/30 bg-transparent";
const chipClass =
  "rounded bg-muted px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground";
const linkClass = "text-xs text-muted-foreground hover:text-foreground";

/**
 * Standing practices (PLAN-64 Phase 3): what the agent was told about how to
 * do a kind of task, where each one applies, and the owner's say over it.
 * Reads `memory.practices`; every change goes through the admin `memory.*`
 * methods. Renders nothing on a gateway that has no practices method.
 */
export function PracticesSection() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [confirm, confirmElement] = useConfirm();
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "unavailable">("loading");
  const [practices, setPractices] = useState<PracticeRow[]>([]);
  const [taskTypes, setTaskTypes] = useState<TaskTypeRow[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PracticeJobRow[]>([]);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [newStatement, setNewStatement] = useState("");
  const [newScope, setNewScope] = useState("global");
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState("");
  const [showPending, setShowPending] = useState(false);

  const load = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const res = (await request("memory.practices", {
        includePendingTaskTypes: true,
      })) as PracticesResult;
      setPractices(res.practices ?? []);
      setTaskTypes(res.taskTypes ?? []);
      setActiveProject(res.activeProject ?? null);
      setJobs(res.jobs ?? []);
      setState("ready");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err ?? "");
      // An older gateway has no such method: the section is left out.
      setState(raw.toLowerCase().includes("missing scope") ? "forbidden" : "unavailable");
    }
  }, [status, request]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Optimistic change: apply it, call the gateway, put the list back if it refuses. */
  const change = async (
    apply: (list: PracticeRow[]) => PracticeRow[],
    method: string,
    params: Record<string, unknown>,
    failure: string,
  ): Promise<boolean> => {
    const before = practices;
    setPractices(apply(before));
    try {
      const res = (await request(method, params)) as { ok?: boolean } | undefined;
      if (res?.ok === false) {
        throw new Error("It changed in the meantime. The list was reloaded.");
      }
      return true;
    } catch (err) {
      setPractices(before);
      toast.error(failure, { description: describeChangeError(err) });
      void load();
      return false;
    }
  };

  const setStatus = (id: string, next: PracticeStatus) => (list: PracticeRow[]) =>
    list.map((p) => (p.id === id ? { ...p, status: next } : p));

  const answer = (p: PracticeRow, yes: boolean) =>
    change(
      setStatus(p.id, yes ? "active" : "suppressed"),
      "memory.answerPracticeOffer",
      { id: p.id, answer: yes ? "yes" : "no" },
      yes ? "Could not save it" : "Could not decline it",
    );

  const retire = async (p: PracticeRow) => {
    if (
      !(await confirm({
        title: "Retire this practice?",
        description:
          "Your agent stops being given it, and cannot store the same instruction again on its own. You can bring it back from this list.",
        actionLabel: "Retire",
        destructive: true,
      }))
    )
      return;
    await change(
      setStatus(p.id, "retired"),
      "memory.retirePractice",
      { id: p.id },
      "Could not retire it",
    );
  };

  const bringBack = (p: PracticeRow) =>
    change(
      setStatus(p.id, "active"),
      "memory.unretirePractice",
      { id: p.id },
      "Could not bring it back",
    );

  const saveEdit = async () => {
    if (!editing) return;
    const statement = editing.draft.trim();
    const { id } = editing;
    if (!statement) return;
    if (
      await change(
        (list) => list.map((p) => (p.id === id ? { ...p, statement } : p)),
        "memory.editPractice",
        { id, statement },
        "Could not update it",
      )
    ) {
      setEditing(null);
    }
  };

  const setScope = async (p: PracticeRow, scope: string) => {
    if (scope === p.scope) return;
    if (
      await change(
        // The label comes back from the gateway on the reload below.
        (list) =>
          list.map((x) =>
            x.id === p.id
              ? { ...x, scope, scopeLabel: jobs.find((j) => j.scope === scope)?.name }
              : x,
          ),
        "memory.setPracticeScope",
        { id: p.id, scope },
        "Could not change where it applies",
      )
    ) {
      void load();
    }
  };

  const add = async () => {
    const statement = newStatement.trim();
    if (!statement) return;
    try {
      await request("memory.savePractice", { statement, scope: newScope });
      setNewStatement("");
      toast.success("Practice saved");
      void load();
    } catch (err) {
      toast.error("Could not save it", { description: describeChangeError(err) });
    }
  };

  const merge = async () => {
    if (!mergeFrom || !mergeInto || mergeFrom === mergeInto) return;
    try {
      await request("memory.mergeTaskTypes", { from: mergeFrom, into: mergeInto });
      setMergeFrom(null);
      setMergeInto("");
      toast.success("Task types merged");
      void load();
    } catch (err) {
      toast.error("Could not merge them", { description: describeChangeError(err) });
    }
  };

  if (state === "loading" || state === "unavailable") return null;

  const recurring = taskTypes.filter((t) => t.recurring !== false);
  const pendingCount = taskTypes.length - recurring.length;
  const shownTypes = showPending ? taskTypes : recurring;
  /** The scopes a practice can be moved to; `current` is kept when it is none of them. */
  const scopeOptions = (current?: PracticeRow): Array<{ value: string; label: string }> => {
    const options = [
      { value: "global", label: "Everywhere" },
      ...recurring.map((t) => ({ value: `task:${t.slug}`, label: `For ${taskTypeName(t)}` })),
      ...(activeProject
        ? [{ value: `project:${activeProject}`, label: `For project ${activeProject}` }]
        : []),
      ...jobs.map((j) => ({ value: j.scope, label: `For the scheduled job ${j.name}` })),
    ];
    if (current && !options.some((o) => o.value === current.scope)) {
      options.push({ value: current.scope, label: describePracticeScope(current) });
    }
    return options;
  };
  const sorted = practices.toSorted(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.savedAt ?? b.createdAt) - (a.savedAt ?? a.createdAt),
  );

  return (
    <section className="space-y-2" data-testid="practices-section">
      <h2 className="text-lg font-semibold text-foreground">Practices</h2>
      <p className="text-xs text-muted-foreground">
        Standing instructions for how to do a kind of task. Only active ones are given to your
        agent, on the requests they apply to.
      </p>

      {state === "forbidden" ? (
        <div className="p-4 text-sm rounded-xl border border-border/20 bg-card/60 text-muted-foreground">
          This session is not allowed to read practices.
        </div>
      ) : (
        <>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input
              value={newStatement}
              onChange={(e) => setNewStatement(e.target.value)}
              placeholder="Add one, e.g. Include npm downloads"
              aria-label="New practice"
              className={cn(inputClass, "flex-1 min-w-48")}
            />
            <select
              value={newScope}
              onChange={(e) => setNewScope(e.target.value)}
              aria-label="Where the new practice applies"
              className={selectClass}
            >
              {scopeOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!newStatement.trim()}
              className="px-3 py-1 text-xs rounded-lg bg-brand text-white disabled:opacity-50"
            >
              Add
            </button>
          </form>

          {sorted.length === 0 ? (
            <div className="p-4 text-sm rounded-xl border border-border/20 bg-card/60 text-muted-foreground">
              No practices yet: one is saved when you tell your agent how to do a kind of task, or
              when you say yes after it notices you asking for the same extra thing twice.
            </div>
          ) : (
            <ul className="space-y-2" data-testid="practices-list">
              {sorted.map((p) => {
                const live = p.status === "active" || p.status === "candidate";
                const applied = p.counts?.applied ?? p.appliedCount ?? 0;
                const repeats = p.counts?.repeats ?? 0;
                const notFollowed = p.counts?.notFollowed ?? 0;
                const evidence = (p.evidence ?? []).filter((e) => e.text);
                return (
                  <li
                    key={p.id}
                    data-testid={`practice-${p.id}`}
                    className="rounded-xl border border-border/20 bg-card/60 p-3 space-y-1.5"
                  >
                    {editing?.id === p.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={editing.draft}
                          onChange={(e) => setEditing({ id: p.id, draft: e.target.value })}
                          rows={2}
                          aria-label="Practice text"
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
                            onClick={() => setEditing(null)}
                            className="text-xs text-muted-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p
                        className={cn(
                          "text-sm break-words",
                          live ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {p.statement}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={chipClass} title="Where this practice applies">
                        {describePracticeScope(p)}
                      </span>
                      <span
                        className={cn(
                          chipClass,
                          p.status === "candidate" && "bg-brand/10 text-brand",
                        )}
                      >
                        {describePracticeStatus(p.status)}
                      </span>
                    </div>
                    <p className="text-2xs text-muted-foreground">
                      {p.status === "candidate" ? "Noticed" : "Saved"}{" "}
                      {formatDate(p.savedAt ?? p.createdAt)}
                      {p.status !== "candidate" && (
                        <>
                          {" · "}
                          <span title="Counts the requests whose instructions included it, not whether the answer followed it">
                            given to your agent {times(applied)}
                          </span>
                          {" · "}
                          <span title="Times you had to say it again">
                            repeated by you {times(repeats)}
                          </span>
                          {notFollowed > 0 && (
                            <>
                              {" · "}
                              <span title="Times it was given to your agent and its words were not in the answer (a word match, not a judgement)">
                                not in the answer {times(notFollowed)}
                              </span>
                            </>
                          )}
                        </>
                      )}
                    </p>
                    {evidence.map((e) => (
                      <p key={e.ref} className="text-xs text-muted-foreground break-words">
                        You said: "{e.text}"
                      </p>
                    ))}
                    <div className="flex flex-wrap items-center gap-3 pt-0.5">
                      {p.status === "candidate" && (
                        <>
                          <button
                            onClick={() => void answer(p, true)}
                            className="px-3 py-1 text-xs rounded-lg bg-brand text-white"
                          >
                            Yes, every time
                          </button>
                          <button onClick={() => void answer(p, false)} className={linkClass}>
                            No
                          </button>
                        </>
                      )}
                      {live && editing?.id !== p.id && (
                        <button
                          onClick={() => setEditing({ id: p.id, draft: p.statement })}
                          className="flex items-center gap-1 text-xs text-brand hover:underline"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                      )}
                      {live && (
                        <select
                          value={p.scope}
                          onChange={(e) => void setScope(p, e.target.value)}
                          aria-label={`Where "${p.statement}" applies`}
                          className={cn(selectClass, "h-7 text-xs")}
                        >
                          {scopeOptions(p).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                      {p.status === "active" && (
                        <button
                          onClick={() => void retire(p)}
                          className="text-xs text-muted-foreground hover:text-danger"
                        >
                          Retire
                        </button>
                      )}
                      {(p.status === "retired" || p.status === "suppressed") && (
                        <button onClick={() => void bringBack(p)} className={linkClass}>
                          Bring back
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {taskTypes.length > 0 && (
            <div className="space-y-1 pt-1" data-testid="task-types">
              <h3 className="text-sm font-semibold text-foreground">Task types</h3>
              <p className="text-xs text-muted-foreground">
                Kinds of request you make. A practice can be tied to a recurring one. If one task
                shows up as two types, merge them.
              </p>
              <ul className="space-y-1">
                {shownTypes.map((t) => (
                  <li key={t.slug} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="flex-1 min-w-0 break-words">
                      {taskTypeName(t)}
                      <span className="ml-2 text-xs text-muted-foreground">
                        asked {times(t.occurrences)}
                      </span>
                      <span className={cn(chipClass, "ml-2")}>
                        {t.recurring !== false ? "Recurring" : "Not recurring yet"}
                      </span>
                    </span>
                    {mergeFrom === t.slug ? (
                      <span className="flex items-center gap-2">
                        <select
                          value={mergeInto}
                          onChange={(e) => setMergeInto(e.target.value)}
                          aria-label={`Merge ${taskTypeName(t)} into`}
                          className={cn(selectClass, "h-7 text-xs")}
                        >
                          <option value="">Merge into…</option>
                          {recurring
                            .filter((x) => x.slug !== t.slug)
                            .map((x) => (
                              <option key={x.slug} value={x.slug}>
                                {taskTypeName(x)}
                              </option>
                            ))}
                        </select>
                        <button
                          onClick={() => void merge()}
                          disabled={!mergeInto}
                          className="px-3 py-1 text-xs rounded-lg bg-brand text-white disabled:opacity-50"
                        >
                          Merge
                        </button>
                        <button onClick={() => setMergeFrom(null)} className={linkClass}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      recurring.some((x) => x.slug !== t.slug) && (
                        <button
                          onClick={() => {
                            setMergeFrom(t.slug);
                            setMergeInto("");
                          }}
                          className={linkClass}
                        >
                          Merge into another
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
              {pendingCount > 0 && (
                <button onClick={() => setShowPending((v) => !v)} className={linkClass}>
                  {showPending
                    ? "Hide the ones that are not recurring yet"
                    : `Show ${pendingCount} not recurring yet`}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {confirmElement}
    </section>
  );
}
