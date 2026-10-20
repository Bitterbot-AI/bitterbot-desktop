import { create } from "zustand";

export type CronJob = {
  id: string;
  label?: string;
  schedule: string;
  text: string;
  enabled: boolean;
  sessionKey?: string;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt?: number;
  updatedAt?: number;
  /** How the most recent run ended. */
  lastRunStatus?: "ok" | "error" | "skipped";
  /** Failed runs in a row; a recurring job is turned off when this gets high. */
  consecutiveErrors?: number;
  /** Where the result goes. Absent means the agent's most recent conversation. */
  delivery?: { mode?: "announce" | "none"; channel?: string; to?: string };
  [key: string]: unknown;
};

/** What the Cron page shows for how a job is doing. */
export function cronJobHealth(job: CronJob): {
  tone: "ok" | "warn" | "bad" | "idle";
  text: string;
} {
  const errors = job.consecutiveErrors ?? 0;
  if (!job.enabled && errors > 1) {
    return { tone: "bad", text: `Turned off after ${errors} failures in a row` };
  }
  if (!job.enabled && job.lastRunStatus === "error") {
    return { tone: "bad", text: "Failed and will not run again" };
  }
  if (job.lastRunStatus === "error") {
    return { tone: "warn", text: errors > 1 ? `Failing (${errors} in a row)` : "Last run failed" };
  }
  if (job.lastRunStatus === "ok") {
    return { tone: "ok", text: "Last run OK" };
  }
  return { tone: "idle", text: job.enabled ? "Has not run yet" : "Off" };
}

export type CronRunEntry = {
  ts: number;
  jobId: string;
  status: "ok" | "error" | "skipped";
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
};

type CronState = {
  jobs: CronJob[];
  runLogs: Record<string, CronRunEntry[]>;
  loading: boolean;
  error: string | null;
  setJobs: (jobs: CronJob[]) => void;
  setRunLogs: (jobId: string, entries: CronRunEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  updateJob: (id: string, patch: Partial<CronJob>) => void;
  removeJob: (id: string) => void;
  addJob: (job: CronJob) => void;
};

export const useCronStore = create<CronState>((set) => ({
  jobs: [],
  runLogs: {},
  loading: false,
  error: null,
  setJobs: (jobs) => set({ jobs }),
  setRunLogs: (jobId, entries) => set((s) => ({ runLogs: { ...s.runLogs, [jobId]: entries } })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  updateJob: (id, patch) =>
    set((s) => ({
      jobs: s.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    })),
  removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((job) => job.id !== id) })),
  addJob: (job) => set((s) => ({ jobs: [...s.jobs, job] })),
}));
