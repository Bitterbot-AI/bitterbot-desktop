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
  [key: string]: unknown;
};

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
  setRunLogs: (jobId, entries) =>
    set((s) => ({ runLogs: { ...s.runLogs, [jobId]: entries } })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  updateJob: (id, patch) =>
    set((s) => ({
      jobs: s.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    })),
  removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((job) => job.id !== id) })),
  addJob: (job) => set((s) => ({ jobs: [...s.jobs, job] })),
}));
