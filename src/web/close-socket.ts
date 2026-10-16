/**
 * Close a Baileys socket's underlying WebSocket without awaiting it.
 *
 * Since Baileys 7.0.0-rc10, `WebSocketClient.close()` is async: it resolves
 * only once the transport emits `close`, and any failure surfaces as a
 * rejected promise rather than a synchronous throw. A bare
 * `try { sock.ws.close() } catch {}` therefore no longer catches errors and
 * can leak an unhandled rejection. This helper keeps call sites
 * fire-and-forget while handling both the sync and async failure paths.
 */
export function closeWaSocketTransport(
  sock: { ws?: { close: () => unknown } | null } | null | undefined,
  onError?: (err: unknown) => void,
): void {
  try {
    const result = sock?.ws?.close();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch((err: unknown) => onError?.(err));
    }
  } catch (err) {
    onError?.(err);
  }
}
