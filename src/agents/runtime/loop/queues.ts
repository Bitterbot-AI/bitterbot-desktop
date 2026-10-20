/**
 * PLAN-52 Phase 2: steering and follow-up queues.
 *
 * Port of pi-agent-core 0.73.1's `PendingMessageQueue` (private to pi's
 * `agent.js`). Same behaviour; the class is exported here because the tool
 * loop needs a non-draining "is steering queued" check.
 */
import type { AgentMessage } from "./events.js";

/**
 * - "all": `drain()` returns every queued message.
 * - "one-at-a-time": `drain()` returns the oldest message only.
 */
export type QueueMode = "all" | "one-at-a-time";

export class PendingMessageQueue {
  mode: QueueMode;
  private messages: AgentMessage[] = [];

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  /** Remove and return the next message(s) according to `mode`. */
  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    if (!first) {
      return [];
    }
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }
}
