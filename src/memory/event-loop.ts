/**
 * Cooperative-yielding helpers for the memory subsystem.
 *
 * The memory engines (consolidation, curiosity region rebuild, file indexing,
 * GCCRF scoring) run IN-PROCESS on the gateway's single Node event loop and use
 * the synchronous `node:sqlite` driver. A long uninterrupted synchronous burst
 * (e.g. an O(n^2) cosine sweep over hundreds of chunks, or thousands of INSERTs)
 * starves the loop. While it runs, the gateway cannot emit its 30s WebSocket
 * keepalive `tick`, so the Control UI's watchdog trips its tick-timeout and
 * bounces the connection (observed as repeated 1006 reconnects).
 *
 * The fix is cooperative multitasking: heavy loops `await yieldToEventLoop()`
 * every N iterations, handing control back so queued WS frames (including the
 * keepalive) flush before the next slice runs. The work still completes; it just
 * no longer monopolizes the loop.
 *
 * `setImmediate` (not `setTimeout(0)`) is used deliberately: it schedules the
 * continuation after the current I/O/poll phase, so pending socket writes drain
 * first, with lower overhead than a timer.
 */

/** Hand control back to the event loop for one tick so pending I/O can flush. */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Yield only once every `every` calls, tracked via a tiny mutable counter, so a
 * hot loop pays the (cheap) `setImmediate` round-trip on a fraction of its
 * iterations rather than every one.
 *
 * Usage:
 *   const tick = makeYieldEvery(64);
 *   for (...) { ...heavy work...; await tick(); }
 */
export function makeYieldEvery(every: number): () => Promise<void> {
  const interval = Math.max(1, Math.floor(every));
  let count = 0;
  return () => {
    count += 1;
    if (count % interval === 0) {
      return yieldToEventLoop();
    }
    return Promise.resolve();
  };
}
