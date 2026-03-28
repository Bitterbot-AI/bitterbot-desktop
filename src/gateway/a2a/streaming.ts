import type { ServerResponse } from "node:http";
import type { A2aStreamEvent } from "./types.js";
import type { A2aTaskManager } from "./task-manager.js";

/**
 * Wire an SSE stream to a task's lifecycle events.
 *
 * Writes `text/event-stream` data to `res` for every status change
 * and artifact produced by the task. Closes the stream on final state
 * or client disconnect.
 */
export function streamTaskEvents(params: {
  res: ServerResponse;
  taskId: string;
  taskManager: A2aTaskManager;
}): void {
  const { res, taskId, taskManager } = params;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Buffer events while the socket is under backpressure.
  let paused = false;
  const pendingEvents: A2aStreamEvent[] = [];

  function flushPending(): void {
    while (pendingEvents.length > 0 && !paused) {
      const next = pendingEvents.shift()!;
      writeSseEvent(res, next);
    }
  }

  res.on("drain", () => {
    paused = false;
    flushPending();
  });

  const unsubscribe = taskManager.subscribe(taskId, (event: A2aStreamEvent) => {
    if (paused) {
      pendingEvents.push(event);
      return;
    }

    const ok = writeSseEvent(res, event);
    if (!ok) {
      paused = true;
    }

    if (event.type === "status" && event.final) {
      // Flush any remaining events before closing.
      flushPending();
      res.end();
    }
  });

  res.on("close", () => {
    unsubscribe();
    pendingEvents.length = 0;
  });
}

/** Write an SSE event. Returns false if the write buffer is full (backpressure). */
function writeSseEvent(res: ServerResponse, event: A2aStreamEvent): boolean {
  const data = JSON.stringify(event);
  return res.write(`event: ${event.type}\ndata: ${data}\n\n`);
}
