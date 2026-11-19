/**
 * RLM Sandbox — runs LLM-written JavaScript that explores a loaded context
 * string. No filesystem, network API, or require access is offered to it.
 *
 * SECURITY (report by Aleksandr Tynianov, 2026-11-19: deep_recall RLM sandbox
 * escape -> host RCE). The code that runs here is written by a sub-LLM that
 * reads attacker-influenced text, so it is treated as hostile. The previous
 * implementation ran it in a node:vm context inside the gateway and seeded
 * that context with host-realm objects; one constructor-chain hop
 * (`Error.constructor("return process")()`) reached the gateway's `process`.
 *
 * There are now two independent layers.
 *
 * Layer 1, process isolation (this file). The vm lives in a separate `node`
 * process, never in the gateway:
 *
 *   - started with an EMPTY environment (no API keys, no tokens);
 *   - under the Node permission model: no filesystem, no child processes, no
 *     worker threads, no native addons (the program arrives on stdin, so not
 *     even its own script needs to be readable);
 *   - with a capped heap, so runaway allocation kills the child, not the
 *     gateway;
 *   - killed outright when a run overruns its deadline, which is what stops a
 *     loop that spins after an `await` (the vm timeout only bounds synchronous
 *     code).
 *
 *   The gateway talks to it over an IPC channel carrying JSON. Every message
 *   from the child is untrusted and type-checked; the only things it can ask
 *   for are the same bridged calls sandbox code may make anyway (llm_query,
 *   search, loadTranscript, listSessions), and only while a run is in flight.
 *   The gateway never evaluates anything the child sends.
 *
 * Layer 2, realm hardening (sandbox-child-source.ts, vm-realm-hardening.ts).
 * Inside the child, no object of the child's own main realm is reachable from
 * sandbox code: null-prototype global, code generation off, every helper
 * defined inside the realm, a two-function string-only bridge, stack capture
 * pinned off, the `import` keyword refused. An escape from layer 2 lands in a
 * process that holds no secrets and may not touch the disk or spawn anything.
 *
 * Not covered: the permission model of Node 22 does not restrict outbound
 * network access, so code that defeats layer 2 could still open a socket from
 * the child. It would have only the context string to send.
 *
 * State model: the store is the durable state. After every run the child
 * returns a JSON snapshot of it, and the synchronous accessors below
 * (exportStore, getVariable, resolveFinalAnswer) read that snapshot, so the
 * gateway never calls into sandbox code. The child is disposable: it is
 * stopped when idle and after a timeout, and the next run starts a fresh one
 * from the snapshot. Realm globals do not survive that; store() does.
 *
 * Based on: "Recursive Language Models" (Zhang, Kraska, Khattab, 2026)
 * Paper: https://arxiv.org/abs/2512.24601
 * Reference: hampton-io/RLM (TypeScript)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { SANDBOX_CHILD_SOURCE } from "./sandbox-child-source.js";
import type { RLMLiveApis, SandboxExecutionResult } from "./types.js";

export type SandboxOptions = {
  /** The full context string to explore. */
  context: string;
  /** Per-execution timeout in ms. Default: 30000. */
  timeout?: number;
  /** Async callback for recursive LLM sub-calls. */
  onLLMQuery: (prompt: string, subContext?: string) => Promise<string>;
  /** Async callback for parallel LLM sub-calls. */
  onLLMQueryParallel?: (queries: Array<{ prompt: string; context?: string }>) => Promise<string[]>;
  /** Live read-only data-access APIs (search, transcripts). */
  liveApis?: RLMLiveApis;
};

/** Cap live-API return payloads so a single call can't blow the REPL loop. */
const LIVE_API_MAX_CHARS = 400_000;
/** V8 old-space cap for the sandbox process. */
const CHILD_HEAP_MB = 512;
/** How long a new sandbox process may take to report ready. */
const CHILD_READY_TIMEOUT_MS = 15_000;
/** An idle sandbox process is stopped after this long; the store snapshot stays. */
const CHILD_IDLE_MS = 120_000;
/** Grace on top of the vm timeout before the process is killed. */
const HARD_TIMEOUT_GRACE_MS = 5_000;
/** Output accepted from one run (the child stops sending at 1M chars). */
const MAX_OUTPUT_CHARS = 1_100_000;
/** Bridged calls (llm_query, search, ...) accepted per run. */
const MAX_BRIDGE_CALLS_PER_RUN = 500;

/**
 * Whether this runtime accepts a permission-model flag. Set to null once a
 * spawn shows it does not (the child is then still a separate process with an
 * empty environment and a capped heap).
 */
let permissionFlag: string | null | undefined;

function resolvePermissionFlag(): string | null {
  if (permissionFlag === undefined) {
    const flags = process.allowedNodeEnvironmentFlags;
    permissionFlag = flags.has("--permission")
      ? "--permission"
      : flags.has("--experimental-permission")
        ? "--experimental-permission"
        : null;
  }
  return permissionFlag;
}

/** Test hook: report which permission flag sandbox processes are started with. */
export function sandboxPermissionFlagForTest(): string | null {
  return resolvePermissionFlag();
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Windows needs SystemRoot for Node to start; it carries no secret.
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

function errorText(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "error";
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asOptionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseStore(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to an empty store.
  }
  return {};
}

type ChildHandle = {
  proc: ChildProcess;
  /** True once the realm holds the current context (an init was sent). */
  initialized: boolean;
};

export class RLMSandbox {
  private child: ChildHandle | null = null;
  private disposed = false;
  private output: string[] = [];
  private finalAnswer: string | null = null;
  private finalVarName: string | null = null;
  private finalVarValue: string | null = null;
  /** JSON snapshot of the store: what the last run left, plus imports since. */
  private storeJson = "{}";
  /** Imports not yet delivered to a live child (existing keys win there too). */
  private pendingImport: Record<string, unknown> | null = null;
  private needsRebuild = false;
  private resetFinalOnNextRun = false;
  private readonly timeout: number;
  private runCounter = 0;
  private bridgeCallsThisRun = 0;
  private outputChars = 0;
  private pendingRun: { id: string; settle: (error: string | null) => void } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Mutable handler slots so a persistent sandbox can be re-bound to a new
  // executor run (each run brings its own cost tracker closure).
  private handlers: {
    onLLMQuery: SandboxOptions["onLLMQuery"];
    onLLMQueryParallel?: SandboxOptions["onLLMQueryParallel"];
  };

  constructor(private options: SandboxOptions) {
    this.timeout = options.timeout ?? 30_000;
    this.handlers = {
      onLLMQuery: options.onLLMQuery,
      onLLMQueryParallel: options.onLLMQueryParallel,
    };
  }

  /** Re-bind LLM callbacks for a new executor run (persistent sandbox reuse). */
  setHandlers(handlers: {
    onLLMQuery: SandboxOptions["onLLMQuery"];
    onLLMQueryParallel?: SandboxOptions["onLLMQueryParallel"];
  }): void {
    this.handlers = handlers;
  }

  /** Whether live data-access APIs are available in this sandbox. */
  hasLiveApis(): boolean {
    const apis = this.options.liveApis;
    return Boolean(apis && (apis.search || apis.loadTranscript || apis.listSessions));
  }

  private liveApiNames(): string {
    const liveApis = this.options.liveApis ?? {};
    return (["search", "loadTranscript", "listSessions"] as const)
      .filter((name) => Boolean(liveApis[name]))
      .join(",");
  }

  // ---------------------------------------------------------------------
  // Child process lifecycle
  // ---------------------------------------------------------------------

  private killChild(): void {
    const handle = this.child;
    this.child = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (handle) {
      handle.proc.removeAllListeners("message");
      try {
        handle.proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  private startChild(flag: string | null): Promise<ChildHandle> {
    return new Promise<ChildHandle>((resolve, reject) => {
      const args = [`--max-old-space-size=${CHILD_HEAP_MB}`, ...(flag ? [flag] : []), "-"];
      let proc: ChildProcess;
      try {
        proc = spawn(process.execPath, args, {
          stdio: ["pipe", "ignore", "ignore", "ipc"],
          env: childEnv(),
          windowsHide: true,
        });
      } catch (err) {
        reject(new Error(`could not start the sandbox process: ${errorText(err)}`));
        return;
      }
      const handle: ChildHandle = { proc, initialized: false };
      let settled = false;
      const readyTimer = setTimeout(() => {
        fail(new Error("sandbox process did not become ready"));
      }, CHILD_READY_TIMEOUT_MS);
      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(readyTimer);
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        reject(err);
      };
      proc.once("error", (err) => fail(new Error(`sandbox process error: ${errorText(err)}`)));
      proc.on("exit", (code, signal) => {
        fail(new Error(`sandbox process exited before ready (${signal ?? code})`));
        this.onChildExit(handle, code, signal);
      });
      proc.on("message", (message: unknown) => {
        if (!settled) {
          if (
            message !== null &&
            typeof message === "object" &&
            (message as { t?: unknown }).t === "ready"
          ) {
            settled = true;
            clearTimeout(readyTimer);
            resolve(handle);
          }
          return;
        }
        this.onChildMessage(handle, message);
      });
      proc.stdin?.on("error", () => {
        // The exit handler reports a child that died before reading its program.
      });
      proc.stdin?.end(SANDBOX_CHILD_SOURCE);
      // The sandbox process must never keep the gateway alive on its own.
      proc.unref();
      (proc.channel as { unref?: () => void } | null | undefined)?.unref?.();
    });
  }

  private async ensureChild(): Promise<ChildHandle> {
    if (this.child) {
      return this.child;
    }
    const flag = resolvePermissionFlag();
    let handle: ChildHandle;
    try {
      handle = await this.startChild(flag);
    } catch (err) {
      if (flag === null) {
        throw err;
      }
      // A runtime that rejects the permission flag: run without it rather than
      // lose deep_recall. Process isolation, the empty env and the heap cap hold.
      handle = await this.startChild(null);
      permissionFlag = null;
    }
    if (this.disposed) {
      try {
        handle.proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      throw new Error("Sandbox has been disposed");
    }
    this.child = handle;
    return handle;
  }

  private send(handle: ChildHandle, message: Record<string, unknown>): void {
    try {
      handle.proc.send(message);
    } catch {
      // A dead child is reported by its exit event.
    }
  }

  private onChildExit(handle: ChildHandle, code: number | null, signal: string | null): void {
    if (this.child !== handle) {
      return;
    }
    this.child = null;
    const pending = this.pendingRun;
    if (pending) {
      this.pendingRun = null;
      pending.settle(
        `Sandbox process ended during the run (${signal ?? `exit ${code}`}); ` +
          "the code probably ran out of memory. Stored values from earlier runs are kept.",
      );
    }
  }

  /** Everything here comes from the sandbox process and is untrusted. */
  private onChildMessage(handle: ChildHandle, raw: unknown): void {
    if (this.child !== handle || raw === null || typeof raw !== "object") {
      return;
    }
    const message = raw as Record<string, unknown>;
    const running = this.pendingRun !== null;
    switch (message.t) {
      case "print":
        // The child caps its own output; this second cap holds even if the
        // child's main realm were taken over.
        if (running && this.outputChars < MAX_OUTPUT_CHARS) {
          const text = asText(message.text);
          this.outputChars += text.length + 1;
          this.output.push(text);
        }
        return;
      case "final":
        if (running) {
          this.finalAnswer = asText(message.text);
        }
        return;
      case "finalVar":
        if (running) {
          this.finalVarName = asText(message.text);
        }
        return;
      case "call": {
        const callId = message.callId;
        if (typeof callId !== "number") {
          return;
        }
        const reply = (error: string | null, result: string | null) =>
          this.send(handle, { t: "reply", callId, error, result });
        if (!running) {
          reply("no sandbox run is in progress", null);
          return;
        }
        if (++this.bridgeCallsThisRun > MAX_BRIDGE_CALLS_PER_RUN) {
          reply("too many sandbox calls in one code block", null);
          return;
        }
        void Promise.resolve()
          .then(() => this.dispatchAsync(asText(message.op), asText(message.payload) || "{}"))
          .then(
            (value) => {
              const json = JSON.stringify(value);
              reply(null, typeof json === "string" ? json : null);
            },
            (err: unknown) => reply(errorText(err), null),
          );
        return;
      }
      case "done": {
        const pending = this.pendingRun;
        if (!pending || pending.id !== message.id) {
          return;
        }
        this.pendingRun = null;
        if (typeof message.store === "string") {
          this.storeJson = JSON.stringify(parseStore(message.store));
        }
        this.finalVarValue = typeof message.finalVar === "string" ? message.finalVar : null;
        pending.settle(typeof message.error === "string" ? message.error : null);
        return;
      }
      default:
        return;
    }
  }

  /** Host-side handlers for bridged calls. The payload is JSON text. */
  private async dispatchAsync(op: string, payloadJson: string): Promise<unknown> {
    // Sandbox code controls the payload shape, so every field is type-checked
    // here before it reaches a host handler.
    const parsed = JSON.parse(payloadJson) as unknown;
    const payload: Record<string, unknown> =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const liveApis = this.options.liveApis ?? {};
    const capText = (text: string): string =>
      text.length > LIVE_API_MAX_CHARS
        ? text.slice(0, LIVE_API_MAX_CHARS) + "\n[... truncated: live API payload cap reached ...]"
        : text;

    switch (op) {
      case "llm_query": {
        return String(
          await this.handlers.onLLMQuery(asText(payload.prompt), asOptionalText(payload.context)),
        );
      }
      case "llm_query_parallel": {
        if (!Array.isArray(parsed)) {
          throw new Error("llm_query_parallel expects an array of { prompt, context }");
        }
        const queries = parsed.map((entry: unknown) => {
          const q =
            entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          return { prompt: asText(q.prompt), context: asOptionalText(q.context) };
        });
        if (this.handlers.onLLMQueryParallel) {
          return (await this.handlers.onLLMQueryParallel(queries)).map(String);
        }
        // Fallback: sequential execution if parallel not provided
        const results: string[] = [];
        for (const q of queries) {
          results.push(String(await this.handlers.onLLMQuery(q.prompt, q.context)));
        }
        return results;
      }
      // Live API wrappers: guard errors, cap payload sizes, stay read-only.
      case "search": {
        if (!liveApis.search) {
          throw new Error("search is not available");
        }
        const wanted = typeof payload.maxResults === "number" ? payload.maxResults : 0;
        try {
          const results = await liveApis.search(asText(payload.query), {
            maxResults: Math.min(Math.max(1, wanted || 10), 50),
          });
          return results.map((r) => ({
            snippet: capText(String(r.snippet ?? "")).slice(0, 4000),
            score: r.score,
            path: r.path,
            source: r.source,
          }));
        } catch (err) {
          return [{ snippet: `[search error: ${errorText(err)}]`, score: 0 }];
        }
      }
      case "loadTranscript": {
        if (!liveApis.loadTranscript) {
          throw new Error("loadTranscript is not available");
        }
        try {
          const text = await liveApis.loadTranscript(asText(payload.sessionId));
          return text === null ? null : capText(text);
        } catch (err) {
          return `[loadTranscript error: ${errorText(err)}]`;
        }
      }
      case "listSessions": {
        if (!liveApis.listSessions) {
          throw new Error("listSessions is not available");
        }
        try {
          return await liveApis.listSessions();
        } catch (err) {
          return [{ sessionId: `[listSessions error: ${errorText(err)}]`, modifiedAt: "" }];
        }
      }
      default:
        throw new Error(`unknown sandbox call: ${op}`);
    }
  }

  /**
   * Execute a code block in the sandbox process. The code is wrapped in an
   * async function so `await` works for llm_query calls. The vm timeout bounds
   * the synchronous part; past the hard deadline the process is killed, which
   * also ends code that spins after an `await`.
   */
  async execute(code: string): Promise<SandboxExecutionResult> {
    this.output = [];
    if (this.disposed) {
      return { output: "", error: "Sandbox has been disposed" };
    }
    if (this.pendingRun) {
      return { output: "", error: "Sandbox is busy with another code block" };
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const runId = String(++this.runCounter);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const handle = await this.ensureChild();
      if (!handle.initialized || this.needsRebuild) {
        this.send(handle, {
          t: "init",
          context: typeof this.options.context === "string" ? this.options.context : "",
          liveApiNames: this.liveApiNames(),
          store: this.storeJson,
        });
        handle.initialized = true;
        this.needsRebuild = false;
        this.pendingImport = null;
      }
      const completion = new Promise<string | null>((resolve) => {
        this.pendingRun = { id: runId, settle: resolve };
      });
      this.bridgeCallsThisRun = 0;
      this.outputChars = 0;
      this.send(handle, {
        t: "exec",
        id: runId,
        code: String(code),
        timeout: this.timeout,
        resetFinal: this.resetFinalOnNextRun,
        importStore: this.pendingImport ? JSON.stringify(this.pendingImport) : null,
      });
      this.resetFinalOnNextRun = false;
      this.pendingImport = null;
      const deadline = new Promise<string>((resolve) => {
        timer = setTimeout(
          () => resolve("Sandbox execution timed out"),
          this.timeout + HARD_TIMEOUT_GRACE_MS,
        );
      });
      const runError = await Promise.race([completion, deadline]);
      if (this.pendingRun?.id === runId) {
        // Deadline passed with the run still open: the process is stuck.
        this.pendingRun = null;
        this.killChild();
      }
      if (runError !== null) {
        return { output: this.output.join("\n"), error: runError };
      }
      return { output: this.output.join("\n") };
    } catch (err) {
      return { output: this.output.join("\n"), error: errorText(err) };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (this.pendingRun?.id === runId) {
        this.pendingRun = null;
      }
      this.armIdleTimer();
    }
  }

  private armIdleTimer(): void {
    if (!this.child || this.idleTimer) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pendingRun) {
        this.killChild();
      }
    }, CHILD_IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** Get the final answer if FINAL() was called. */
  getFinalAnswer(): string | null {
    return this.finalAnswer;
  }

  /** Get the variable name if FINAL_VAR() was called. */
  getFinalVarName(): string | null {
    return this.finalVarName;
  }

  /** Resolve the final answer: check FINAL first, then FINAL_VAR, then null. */
  resolveFinalAnswer(): string | null {
    if (this.finalAnswer !== null) {
      return this.finalAnswer;
    }
    if (this.finalVarName !== null && this.finalVarValue !== null) {
      return this.finalVarValue;
    }
    return null;
  }

  /** Get a JSON copy of a stored variable by name (undefined if absent or not serializable). */
  getVariable(name: string): unknown {
    const store = this.exportStore();
    return Object.hasOwn(store, name) ? store[name] : undefined;
  }

  /** Get the last captured output. */
  getLastOutput(): string {
    return this.output.join("\n");
  }

  /**
   * Clear completion signals only (keep the store). Called when a persistent
   * sandbox is reused for a new query so a stale FINAL from the previous run
   * can't terminate the new run on its first iteration.
   */
  clearFinal(): void {
    this.finalAnswer = null;
    this.finalVarName = null;
    this.finalVarValue = null;
    this.resetFinalOnNextRun = true;
  }

  /** Export JSON-serializable store entries (for durable persistence). */
  exportStore(): Record<string, unknown> {
    return parseStore(this.storeJson);
  }

  /**
   * Import previously exported store entries (merge, existing keys win).
   * The data reaches the sandbox as JSON text and is parsed there.
   */
  importStore(data: Record<string, unknown>): void {
    let incoming: Record<string, unknown>;
    try {
      incoming = parseStore(JSON.stringify(data));
    } catch {
      return;
    }
    const current = parseStore(this.storeJson);
    const queued = this.pendingImport ?? {};
    let changed = false;
    for (const [key, value] of Object.entries(incoming)) {
      if (!Object.hasOwn(current, key)) {
        current[key] = value;
        queued[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.storeJson = JSON.stringify(current);
      this.pendingImport = queued;
    }
  }

  /**
   * Replace the context string (e.g. rebuilt after TTL expiry) while
   * preserving the persistent store. The realm is rebuilt before the next
   * run, so globals, patched prototypes and leftover background code from
   * earlier queries do not carry over.
   */
  updateContext(newContext: string): void {
    this.options = { ...this.options, context: newContext };
    this.needsRebuild = true;
  }

  /** Reset for reuse (keeps context string, clears state). */
  reset(): void {
    this.output = [];
    this.storeJson = "{}";
    this.pendingImport = null;
    this.finalAnswer = null;
    this.finalVarName = null;
    this.finalVarValue = null;
    this.pendingRun = null;
    this.needsRebuild = true;
  }

  dispose(): void {
    this.disposed = true;
    this.output = [];
    this.storeJson = "{}";
    this.pendingImport = null;
    this.finalAnswer = null;
    this.finalVarName = null;
    this.finalVarValue = null;
    const pending = this.pendingRun;
    this.pendingRun = null;
    this.killChild();
    pending?.settle("Sandbox has been disposed");
  }
}
