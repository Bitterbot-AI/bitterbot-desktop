/**
 * Manages code execution sessions.
 * Listens for postMessage results from code-exec iframes and resolves promises.
 */

export interface CodeExecResult {
  execId: string;
  stdout: string;
  stderr: string;
  images: string[]; // base64 data URLs
  returnValue: string | null;
  error: string | null;
}

type ResultCallback = (result: CodeExecResult) => void;

const pendingCallbacks = new Map<string, ResultCallback>();
let listenerAttached = false;

function ensureListener() {
  if (listenerAttached) return;
  listenerAttached = true;

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (data?.type !== "code-exec-result" || !data.execId) return;

    const result: CodeExecResult = {
      execId: data.execId,
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      images: Array.isArray(data.images) ? data.images : [],
      returnValue: data.returnValue ?? null,
      error: data.error ?? null,
    };

    const cb = pendingCallbacks.get(data.execId);
    if (cb) {
      pendingCallbacks.delete(data.execId);
      cb(result);
    }
  });
}

/**
 * Register a callback for when a code execution completes.
 * The iframe will send its result via postMessage with the matching execId.
 */
export function onCodeExecResult(execId: string, callback: ResultCallback): () => void {
  ensureListener();
  pendingCallbacks.set(execId, callback);

  // Return cleanup function
  return () => {
    pendingCallbacks.delete(execId);
  };
}

/**
 * Wait for a code execution result with a timeout.
 */
export function waitForCodeExecResult(execId: string, timeoutMs = 60_000): Promise<CodeExecResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCallbacks.delete(execId);
      reject(new Error(`Code execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    onCodeExecResult(execId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}
