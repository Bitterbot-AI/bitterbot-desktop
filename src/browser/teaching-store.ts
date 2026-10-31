import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  TEACHING_DURATION_MS,
  TEACHING_MAX_ACTIONS,
  TEACHING_MAX_RECORDINGS,
  teachingActionSchema,
  teachingDetailsSchema,
  teachingRecordSchema,
  type TeachingAction,
  type TeachingDetails,
  type TeachingRecord,
} from "./teaching-types.js";

/** Private, bounded local recordings. Active capture is tied to one connection. */
export class BrowserTeachingStore {
  private active: { id: string; connId: string; profile: string; until: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dir: string,
    private readonly now = Date.now,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private file(id: string): string {
    return path.join(this.dir, `${z.string().uuid().parse(id)}.json`);
  }
  private async read(id: string): Promise<TeachingRecord> {
    const record = teachingRecordSchema.parse(JSON.parse(await fs.readFile(this.file(id), "utf8")));
    if (record.id !== id) throw new Error("Recording identity mismatch.");
    return record;
  }
  private async write(record: TeachingRecord): Promise<void> {
    const content = JSON.stringify(teachingRecordSchema.parse(record), null, 2);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.file(record.id)}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, content, { mode: 0o600 });
      await fs.rename(temp, this.file(record.id));
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  private async ids(): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir))
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .map((name) => name.slice(0, -5));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async settle(record: TeachingRecord): Promise<TeachingRecord> {
    if (
      record.status === "recording" &&
      (record.id !== this.active?.id || this.now() >= record.createdAt + TEACHING_DURATION_MS)
    ) {
      record.status = "stopped";
      record.stoppedAt = this.now();
      record.reason =
        record.id === this.active?.id
          ? "Ten-minute recording limit reached."
          : "Recording interrupted; review the captured steps.";
      if (this.active?.id === record.id) this.active = null;
      await this.write(record);
    }
    return record;
  }

  recordingId(connId: string): string | undefined {
    return this.active?.connId === connId && this.now() < this.active.until
      ? this.active.id
      : undefined;
  }
  async reconcile(controller?: string, profile?: string): Promise<void> {
    return this.serial(async () => {
      if (!this.active) return;
      if (
        this.active.connId === controller &&
        this.active.profile === profile &&
        this.now() < this.active.until
      )
        return;
      const record = await this.read(this.active.id);
      record.status = "stopped";
      record.stoppedAt = this.now();
      record.reason =
        this.now() >= this.active.until
          ? "Ten-minute recording limit reached."
          : "Browser control ended; review the captured steps.";
      this.active = null;
      await this.write(record);
    });
  }
  start(connId: string, profile: string, raw: TeachingDetails): Promise<TeachingRecord> {
    return this.serial(async () => {
      if (this.active) throw new Error("Stop the current demonstration first.");
      if ((await this.ids()).length >= TEACHING_MAX_RECORDINGS)
        throw new Error("Delete an old recording before making another (limit 50).");
      const record: TeachingRecord = {
        ...teachingDetailsSchema.parse(raw),
        id: randomUUID(),
        profile,
        createdAt: this.now(),
        status: "recording",
        actions: [],
      };
      await this.write(record);
      this.active = {
        id: record.id,
        connId,
        profile,
        until: record.createdAt + TEACHING_DURATION_MS,
      };
      return record;
    });
  }
  /** Internal only: there is deliberately no action-upload RPC. */
  append(connId: string, id: string, raw: TeachingAction): Promise<void> {
    return this.serial(async () => {
      if (this.recordingId(connId) !== id) return;
      const record = await this.read(id);
      const action = teachingActionSchema.parse(raw);
      const previous = record.actions.at(-1);
      // Coalesce characters/backspaces into one parameter and wheel bursts
      // into one semantic scroll. Never keep the original text or key count.
      if (
        ["type", "scroll", "manual"].includes(action.kind) &&
        JSON.stringify(previous) === JSON.stringify(action)
      )
        return;
      record.actions.push(action);
      if (record.actions.length >= TEACHING_MAX_ACTIONS) {
        record.status = "stopped";
        record.stoppedAt = this.now();
        record.reason = "Recording stopped at the 300-step limit.";
        this.active = null;
      }
      await this.write(record);
    });
  }
  fail(connId: string, id: string): Promise<void> {
    return this.serial(async () => {
      if (this.active?.connId !== connId || this.active.id !== id) return;
      const record = await this.read(id);
      record.status = "failed";
      record.reason = "An interaction could not be captured. Start a new demonstration.";
      record.stoppedAt = this.now();
      this.active = null;
      await this.write(record);
    });
  }
  stop(connId: string, id: string): Promise<TeachingRecord> {
    return this.serial(async () => {
      const record = await this.settle(await this.read(id));
      if (record.status !== "recording") return record;
      if (this.active?.connId !== connId)
        throw new Error("This window did not start the recording.");
      this.active = null;
      record.status = "stopped";
      record.stoppedAt = this.now();
      await this.write(record);
      return record;
    });
  }
  get(id: string): Promise<TeachingRecord> {
    return this.serial(async () => this.settle(await this.read(id)));
  }
  list() {
    return this.serial(async () => {
      const records: TeachingRecord[] = [];
      for (const id of await this.ids()) records.push(await this.settle(await this.read(id)));
      return records
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .map(({ actions, ...record }) => ({ ...record, actionCount: actions.length }));
    });
  }
  /** Serialises draft/stage/activation with capture, deletion and each other. */
  change<T>(id: string, work: (record: TeachingRecord) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const record = await this.settle(await this.read(id));
      const result = await work(record);
      await this.write(record);
      return result;
    });
  }
  remove(id: string, beforeRemove?: (record: TeachingRecord) => Promise<void>): Promise<void> {
    return this.serial(async () => {
      if (this.active?.id === id) throw new Error("Stop the recording before deleting it.");
      if (beforeRemove) await beforeRemove(await this.settle(await this.read(id)));
      await fs.unlink(this.file(id));
    });
  }
}
