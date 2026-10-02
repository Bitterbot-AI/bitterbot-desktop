/**
 * PLAN-52 soak driver: real traffic for agents on either runtime engine,
 * through the running gateway, with every turn checked on disk.
 *
 *   node --import tsx benchmarks/runtime-soak/drive.ts \
 *     --agents drill-haiku,learning-eval-20260905 --rounds 1
 *   node --import tsx benchmarks/runtime-soak/drive.ts \
 *     --agents drill-haiku,drill-haiku-pi,learning-eval-20260905:every=6 \
 *     --rounds 60 --sleep-minutes 6 --max-usd 15 --skip-on-pi abort
 *
 * It talks to the LIVE gateway as an operator, so use it only with test
 * agents (they have their own workspaces and memory). Prompts are neutral
 * tool tasks: nothing here states anything about the user.
 *
 * What a round does, per agent, in a fresh session:
 *   file      write a file with a random token, read it back
 *   exec      run a shell pipeline whose output only the tool can produce
 *   edit      append a line to the file
 *   error     read a file that does not exist; the turn must still end well
 *   chain     read two files, write a third from both
 *   recall    answer from the conversation without tools
 *   compact   /compact through chat.send, then answer from the compacted part
 *   abort     start a long command, abort it, then take another turn
 *   subagent  spawn a sub-agent and report its announced result (every 3rd round)
 *   stream    one turn through chat.send with the event stream counted
 * and, in one long-lived session per agent (`--big-kb`, default for Haiku):
 *   bigread   read a large generated log to the end and report a marked id
 *   probe     report the id from the OLDEST bigread without reading again
 * so the long session crosses the compaction thresholds every few rounds.
 *
 * Checks are made on the workspace files, on `chat.history`, and on the
 * session transcript. Rows go to <state>/eval/runtime-soak/results.jsonl.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { callGateway } = await import("../../src/gateway/call.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const { PROTOCOL_VERSION } = await import("../../src/gateway/protocol/index.js");
const { loadOrCreateDeviceIdentity } = await import("../../src/infra/device-identity.js");
const { loadConfig } = await import("../../src/config/config.js");
const { resolveAgentWorkspaceDir } = await import("../../src/agents/agent-scope.js");
const { resolveRuntimeEngine } = await import("../../src/agents/runtime/engine.js");
const { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } =
  await import("../../src/utils/message-channel.js");

const args = parseArgs({
  options: {
    agents: { type: "string" },
    rounds: { type: "string" },
    "sleep-minutes": { type: "string" },
    "max-usd": { type: "string" },
    "big-kb": { type: "string" },
    only: { type: "string" },
    "skip-on-pi": { type: "string" },
    tag: { type: "string" },
  },
}).values;

const STATE_DIR = process.env.BITTERBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".bitterbot");
const OUT_DIR = path.join(STATE_DIR, "eval", "runtime-soak");
const RESULTS = path.join(OUT_DIR, "results.jsonl");
const LONG_STATE = path.join(OUT_DIR, "long-sessions.json");
const TURN_TIMEOUT_MS = 240_000;

type Check = { name: string; ok: boolean; detail?: string };
type Row = {
  ts: string;
  tag: string;
  round: number;
  agent: string;
  engine: string;
  policy: string;
  scenario: string;
  sessionKey: string;
  ok: boolean;
  ms: number;
  checks: Check[];
};
type HistoryMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
};
type AgentInfo = {
  /** Run this agent only every Nth round (`id:every=N`), for the expensive ones. */
  every: number;
  id: string;
  workspace: string;
  engine: string;
  policy: string;
  model: string;
  bigKb: number;
};

const sha12 = (text: string) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
const token = (prefix: string) => `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function gw<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  return await callGateway<T>({ method, params, timeoutMs });
}

async function startTurn(agent: AgentInfo, sessionKey: string, message: string): Promise<string> {
  const idempotencyKey = crypto.randomUUID();
  const response = await gw<{ runId?: string }>("agent", {
    message,
    sessionKey,
    agentId: agent.id,
    idempotencyKey,
    deliver: false,
    channel: "webchat",
  });
  return typeof response?.runId === "string" && response.runId ? response.runId : idempotencyKey;
}

async function waitRun(runId: string, timeoutMs = TURN_TIMEOUT_MS): Promise<string> {
  const wait = await gw<{ status?: string; error?: string }>(
    "agent.wait",
    { runId, timeoutMs },
    timeoutMs + 5_000,
  );
  return wait?.status === "ok"
    ? "ok"
    : `${wait?.status ?? "unknown"}${wait?.error ? `: ${wait.error}` : ""}`;
}

async function turn(agent: AgentInfo, sessionKey: string, message: string) {
  const started = Date.now();
  const runId = await startTurn(agent, sessionKey, message);
  const status = await waitRun(runId);
  return { status, runId, ms: Date.now() - started };
}

async function history(sessionKey: string, limit = 60) {
  const res = await gw<{ sessionId?: string; messages?: HistoryMessage[] }>("chat.history", {
    sessionKey,
    limit,
  });
  return { sessionId: res.sessionId, messages: res.messages ?? [] };
}

function textOf(message: HistoryMessage | undefined): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

function lastAssistant(messages: HistoryMessage[]): HistoryMessage | undefined {
  return messages.toReversed().find((message) => message.role === "assistant");
}

function toolNames(messages: HistoryMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      const typed = block as { type?: string; name?: string };
      if (typed?.type === "toolCall" || typed?.type === "tool_use") {
        names.push(String(typed.name));
      }
    }
  }
  return names;
}

function sessionFileOf(agentId: string, sessionId: string | undefined): string | undefined {
  if (!sessionId) {
    return undefined;
  }
  const dir = path.join(STATE_DIR, "agents", agentId, "sessions");
  try {
    const name = fs
      .readdirSync(dir)
      .find((entry) => entry.startsWith(sessionId) && entry.endsWith(".jsonl"));
    return name ? path.join(dir, name) : undefined;
  } catch {
    return undefined;
  }
}

function transcriptCounts(file: string | undefined) {
  const counts = { entries: 0, compactions: 0, prunes: 0, errors: 0, offloadCompactions: 0 };
  if (!file) {
    return counts;
  }
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    counts.entries += 1;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        customType?: string;
        details?: unknown;
        message?: { role?: string; stopReason?: string };
      };
      if (entry.type === "compaction") {
        counts.compactions += 1;
        if (entry.details) {
          counts.offloadCompactions += 1;
        }
      } else if (entry.type === "custom" && entry.customType === "bitterbot.offload-prune") {
        counts.prunes += 1;
      } else if (entry.message?.role === "assistant" && entry.message.stopReason === "error") {
        counts.errors += 1;
      }
    } catch {
      // A torn line is the store's problem to report, not the driver's.
    }
  }
  return counts;
}

/** Text shaped like a pasted service log (dense in tokens). */
function logLines(kb: number, seed: number, marker: { at: number; line: string }): string {
  const lines: string[] = [];
  let size = 0;
  let n = seed * 100_000;
  while (size < kb * 1024) {
    n += 1;
    const hex = ((n * 2_654_435_761) >>> 0).toString(16).padStart(8, "0");
    const line = `2026-10-02T${String(n % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:07Z worker-${n % 17} INFO request ${hex} completed in ${(n * 37) % 900} ms status=200 path=/api/v1/items/${(n * 7919) % 100_000}`;
    lines.push(line);
    size += line.length + 1;
  }
  lines.splice(Math.floor(lines.length * marker.at), 0, marker.line);
  return `${lines.join("\n")}\n`;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

type Ctx = { agent: AgentInfo; sessionKey: string; soakDir: string; rel: (name: string) => string };

async function reply(ctx: Ctx, message: string) {
  const result = await turn(ctx.agent, ctx.sessionKey, message);
  const { messages } = await history(ctx.sessionKey);
  const last = lastAssistant(messages);
  return { ...result, messages, text: textOf(last), last };
}

const ended = (r: { status: string; last?: HistoryMessage }): Check => ({
  name: "the turn ended with an assistant answer",
  ok: r.status === "ok" && r.last?.stopReason !== "error",
  detail: r.status === "ok" ? r.last?.stopReason : r.status,
});

async function scenarioFile(ctx: Ctx, state: Record<string, string>): Promise<Check[]> {
  const tok = token("file");
  state.firstToken = tok;
  state.fileA = ctx.rel("a.md");
  const r = await reply(
    ctx,
    `Create the file ${state.fileA} in your workspace containing exactly this one line: ${tok}\nThen read the file back with the read tool and reply with only the line you read.`,
  );
  const onDisk = fs.existsSync(path.join(ctx.agent.workspace, state.fileA))
    ? fs.readFileSync(path.join(ctx.agent.workspace, state.fileA), "utf8")
    : "";
  return [
    ended(r),
    { name: "the file is on disk with the token", ok: onDisk.includes(tok) },
    { name: "the reply has the token", ok: r.text.includes(tok), detail: r.text.slice(0, 80) },
  ];
}

async function scenarioExec(ctx: Ctx): Promise<Check[]> {
  const tok = token("exec");
  const r = await reply(
    ctx,
    `Run this exact command with your shell tool and reply with only its output:\nprintf %s ${tok} | sha256sum | cut -c1-12`,
  );
  return [
    ended(r),
    {
      name: "the reply has the hash only the command can produce",
      ok: r.text.includes(sha12(tok)),
      detail: r.text.slice(0, 80),
    },
  ];
}

async function scenarioEdit(ctx: Ctx, state: Record<string, string>): Promise<Check[]> {
  const tok = token("edit");
  const r = await reply(
    ctx,
    `Add a second line to ${state.fileA} containing exactly: ${tok}\nKeep the first line unchanged. Reply with the single word done.`,
  );
  const onDisk = fs.readFileSync(path.join(ctx.agent.workspace, state.fileA!), "utf8");
  return [
    ended(r),
    {
      name: "the file has both lines",
      ok: onDisk.includes(tok) && onDisk.includes(state.firstToken!),
      detail: JSON.stringify(onDisk.slice(0, 80)),
    },
  ];
}

async function scenarioError(ctx: Ctx): Promise<Check[]> {
  const missing = ctx.rel(`missing-${crypto.randomBytes(3).toString("hex")}.md`);
  const r = await reply(
    ctx,
    `Use the read tool on ${missing}. If the tool reports an error, reply with only the word missing.`,
  );
  return [
    ended(r),
    {
      name: "the model handled the tool error",
      ok: /missing/i.test(r.text),
      detail: r.text.slice(0, 80),
    },
    { name: "a read was attempted", ok: toolNames(r.messages).includes("read") },
  ];
}

// Kept short on purpose: a longer "read, then write" wording lands in the gray
// band of the complexity gate (PLAN-22) and the gateway opens a goal task for
// it on every round, which stays pending.
async function scenarioChain(ctx: Ctx, state: Record<string, string>): Promise<Check[]> {
  const tok = token("chain");
  const fileB = ctx.rel("b.md");
  const fileC = ctx.rel("c.md");
  fs.writeFileSync(path.join(ctx.agent.workspace, fileB), `${tok}\n`);
  const r = await reply(
    ctx,
    `Join the first lines of ${state.fileA} and ${fileB} with a plus sign (no spaces) into ${fileC}. Reply: done.`,
  );
  const expected = `${state.firstToken}+${tok}`;
  const onDisk = fs.existsSync(path.join(ctx.agent.workspace, fileC))
    ? fs.readFileSync(path.join(ctx.agent.workspace, fileC), "utf8")
    : "";
  return [
    ended(r),
    {
      name: "the third file combines the two",
      ok: onDisk.includes(expected),
      detail: onDisk.slice(0, 80),
    },
  ];
}

async function scenarioRecall(ctx: Ctx, state: Record<string, string>, label: string) {
  const r = await reply(
    ctx,
    `Without using any tool: what was the exact line you first wrote to ${state.fileA} at the start of this conversation? Reply with only that line.`,
  );
  return [
    ended(r),
    {
      name: `${label}: the answer is the first token of the conversation`,
      ok: r.text.includes(state.firstToken!),
      detail: r.text.slice(0, 80),
    },
  ];
}

async function scenarioCompact(ctx: Ctx, state: Record<string, string>): Promise<Check[]> {
  const before = await history(ctx.sessionKey);
  const file = sessionFileOf(ctx.agent.id, before.sessionId);
  const countBefore = transcriptCounts(file).compactions;
  await gw("chat.send", {
    sessionKey: ctx.sessionKey,
    message: "/compact Keep every token and file name.",
    idempotencyKey: crypto.randomUUID(),
  });
  let countAfter = countBefore;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(3_000);
    const now = await history(ctx.sessionKey);
    countAfter = transcriptCounts(sessionFileOf(ctx.agent.id, now.sessionId)).compactions;
    if (countAfter > countBefore) {
      break;
    }
  }
  const checks: Check[] = [
    {
      name: "/compact wrote a compaction entry",
      ok: countAfter > countBefore,
      detail: `${countBefore} -> ${countAfter}`,
    },
  ];
  checks.push(...(await scenarioRecall(ctx, state, "after compaction")));
  return checks;
}

async function scenarioAbort(ctx: Ctx): Promise<Check[]> {
  // chat.abort stops runs started by chat.send, so the long run goes that way.
  const runId = crypto.randomUUID();
  await gw("chat.send", {
    sessionKey: ctx.sessionKey,
    message:
      "Run this exact command with your shell tool and wait for it to finish: sleep 90 && echo finished",
    idempotencyKey: runId,
  });
  await sleep(8_000);
  const abortedAt = Date.now();
  const abort = await gw<{ aborted?: boolean }>("chat.abort", {
    sessionKey: ctx.sessionKey,
    runId,
  }).catch((err) => ({ aborted: false, error: String(err) }));
  // The next turn queues behind the session: it answers quickly only if the
  // aborted run really let go.
  // If the model had already answered (for example it sent the command to the
  // background), there was nothing left to abort: that is not a failure.
  const alreadyDone =
    abort.aborted !== true &&
    lastAssistant((await history(ctx.sessionKey)).messages)?.stopReason === "stop";
  const next = await reply(ctx, "Reply with only the word alive.");
  const freedMs = Date.now() - abortedAt;
  return [
    {
      name: "chat.abort stopped the run (or it had already ended)",
      ok: abort.aborted === true || alreadyDone,
      detail: alreadyDone ? "run had already ended" : JSON.stringify(abort).slice(0, 120),
    },
    {
      name: "the session was free again well before the command would have ended",
      ok: freedMs < 45_000,
      detail: `${freedMs} ms after the abort`,
    },
    ended(next),
    { name: "the session takes another turn after the abort", ok: /alive/i.test(next.text) },
  ];
}

async function scenarioSubagent(ctx: Ctx): Promise<Check[]> {
  const tok = token("sub");
  const expected = sha12(tok);
  const first = await turn(
    ctx.agent,
    ctx.sessionKey,
    `Use sessions_spawn to start a sub-agent with this task: "Run this exact command with your shell tool and reply with only its output: printf %s ${tok} | sha256sum | cut -c1-12". When the sub-agent's result is announced to you, reply with only those 12 characters.`,
  );
  let seen = false;
  let spawned = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !seen) {
    await sleep(4_000);
    const { messages } = await history(ctx.sessionKey);
    spawned = toolNames(messages).includes("sessions_spawn");
    seen = messages.some((m) => m.role === "assistant" && textOf(m).includes(expected));
  }
  return [
    { name: "the spawning turn ended", ok: first.status === "ok", detail: first.status },
    { name: "sessions_spawn was called", ok: spawned },
    { name: "the sub-agent's result came back to the parent session", ok: seen },
  ];
}

async function scenarioStream(agent: AgentInfo, sessionKey: string): Promise<Check[]> {
  const cfg = loadConfig();
  const port = cfg.gateway?.port ?? 19001;
  const events: Array<{ state?: string }> = [];
  let helloResolve: () => void = () => {};
  const hello = new Promise<void>((resolve) => {
    helloResolve = resolve;
  });
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: process.env.BITTERBOT_GATEWAY_TOKEN?.trim() || cfg.gateway?.auth?.token,
    instanceId: crypto.randomUUID(),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientVersion: "soak",
    mode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
    deviceIdentity: loadOrCreateDeviceIdentity(),
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    onHelloOk: () => helloResolve(),
    onEvent: (evt) => {
      const payload = evt.payload as { sessionKey?: string; state?: string } | undefined;
      if (evt.event === "chat" && payload?.sessionKey?.endsWith(sessionKey.split(":").pop()!)) {
        events.push({ state: payload.state });
      }
    },
  });
  client.start();
  const tok = token("stream");
  try {
    await Promise.race([hello, sleep(15_000)]);
    await client.request("chat.send", {
      sessionKey,
      message: `Write three short sentences about the number ${tok.length}, then end with the code ${tok}.`,
      idempotencyKey: crypto.randomUUID(),
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !events.some((e) => e.state === "final")) {
      await sleep(1_000);
    }
  } finally {
    client.stop();
  }
  const { messages } = await history(sessionKey);
  const text = textOf(lastAssistant(messages));
  return [
    {
      name: "the client received streamed deltas and one final event",
      ok:
        events.filter((e) => e.state === "delta").length > 0 &&
        events.filter((e) => e.state === "final").length === 1,
      detail: `${events.filter((e) => e.state === "delta").length} delta, ${events.filter((e) => e.state === "final").length} final`,
    },
    {
      name: "the reply on the chat path has the code",
      ok: text.includes(tok),
      detail: text.slice(-60),
    },
  ];
}

type LongState = Record<string, { ids: string[]; sessionKey: string }>;

function loadLongState(): LongState {
  try {
    return JSON.parse(fs.readFileSync(LONG_STATE, "utf8")) as LongState;
  } catch {
    return {};
  }
}

async function scenarioBigRead(
  agent: AgentInfo,
  tag: string,
): Promise<{ key: string; checks: Check[] }> {
  const all = loadLongState();
  const state = (all[agent.id] ??= { ids: [], sessionKey: `agent:${agent.id}:soak-long-${tag}` });
  const n = state.ids.length + 1;
  const id = crypto.randomBytes(4).toString("hex");
  const rel = path.join("soak", "long", `big-${n}.log`);
  fs.mkdirSync(path.join(agent.workspace, "soak", "long"), { recursive: true });
  // Tool results are capped at a few KB before the model sees them, so the
  // file is read in chunks that fit; a turn then adds about 25k tokens.
  const chunkLines = 55;
  const chunks = Math.max(1, Math.round((agent.bigKb * 1024) / 125 / chunkLines));
  const totalLines = chunks * chunkLines;
  fs.writeFileSync(
    path.join(agent.workspace, rel),
    logLines(Math.ceil((totalLines * 125) / 1024) + 4, n, {
      at: 0.2 + 0.6 * Math.random(),
      line: `2026-10-02T12:00:00Z worker-0 WARN MARKER-${n} request ${id} needs attention`,
    }),
  );
  const ctx: Ctx = { agent, sessionKey: state.sessionKey, soakDir: "soak/long", rel: (x) => x };
  const before = transcriptCounts(
    sessionFileOf(agent.id, (await history(state.sessionKey)).sessionId),
  );
  const r = await reply(
    ctx,
    `Read lines 1 to ${totalLines} of the file ${rel} with the read tool, in ${chunks} calls of ${chunkLines} lines each (offset 1, ${chunkLines + 1}, ${2 * chunkLines + 1}, and so on, limit ${chunkLines}). Do not use any other tool and do not skip a chunk. One of those lines contains MARKER-${n}: reply with only the 8-character request id on that line.`,
  );
  state.ids.push(id);
  fs.writeFileSync(LONG_STATE, JSON.stringify(all, null, 1));
  const checks: Check[] = [
    ended(r),
    {
      name: `bigread ${n}: the reply has the marked id`,
      ok: r.text.includes(id),
      detail: r.text.slice(0, 60),
    },
  ];
  if (n > 1) {
    const probe = await reply(
      ctx,
      `Do not read any log file again. What request id did you report for MARKER-1 earlier in this conversation? If it is no longer in view, use recall_range or your memory tools. Reply with only the id.`,
    );
    checks.push(ended(probe), {
      name: "probe: the id from the oldest bigread is recalled",
      ok: probe.text.includes(state.ids[0]!),
      detail: `${probe.text.slice(0, 40)} via ${toolNames(probe.messages.slice(-6)).join(",") || "no tool"}`,
    });
  }
  const after = transcriptCounts(
    sessionFileOf(agent.id, (await history(state.sessionKey)).sessionId),
  );
  checks.push({
    name: "transcript has no error turns",
    ok: after.errors === before.errors,
    detail: `compactions ${before.compactions}->${after.compactions} (offload ${after.offloadCompactions}), prune records ${before.prunes}->${after.prunes}, entries ${after.entries}`,
  });
  return { key: state.sessionKey, checks };
}

// ── Runner ──────────────────────────────────────────────────────────────────

function spentUsd(agentId: string): number {
  try {
    const db = new DatabaseSync(path.join(STATE_DIR, "usage-ledger.sqlite"), { readOnly: true });
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(cost_total), 0) AS usd FROM usage_events WHERE agent_id = ? AND session_key LIKE '%:soak-%'",
      )
      .get(agentId) as { usd: number };
    db.close();
    return row.usd;
  } catch {
    return 0;
  }
}

function record(row: Row): void {
  fs.appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);
  const failed = row.checks.filter((check) => !check.ok);
  console.log(
    `${row.ok ? "PASS" : "FAIL"} ${row.agent} [${row.engine}/${row.policy}] r${row.round} ${row.scenario} ${row.ms} ms` +
      (failed.length
        ? `\n     ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("\n     ")}`
        : ""),
  );
}

async function run(
  agent: AgentInfo,
  round: number,
  tag: string,
  scenario: string,
  sessionKey: string,
  fn: () => Promise<Check[]>,
): Promise<void> {
  const started = Date.now();
  let checks: Check[];
  try {
    checks = await fn();
  } catch (err) {
    checks = [{ name: "scenario ran", ok: false, detail: String(err).slice(0, 300) }];
  }
  record({
    ts: new Date().toISOString(),
    tag,
    round,
    agent: agent.id,
    engine: agent.engine,
    policy: agent.policy,
    scenario,
    sessionKey,
    ok: checks.every((check) => check.ok),
    ms: Date.now() - started,
    checks,
  });
}

async function roundFor(agent: AgentInfo, round: number, tag: string, only?: Set<string>) {
  const skipOnPi = new Set((args["skip-on-pi"] ?? "").split(",").filter(Boolean));
  const want = (name: string) =>
    (!only || only.has(name)) && !(agent.engine === "pi" && skipOnPi.has(name));
  const stamp = `${tag}-r${round}`;
  const sessionKey = `agent:${agent.id}:soak-${stamp}`;
  const soakDir = path.join("soak", stamp);
  fs.mkdirSync(path.join(agent.workspace, soakDir), { recursive: true });
  const ctx: Ctx = { agent, sessionKey, soakDir, rel: (name) => path.join(soakDir, name) };
  const state: Record<string, string> = {};

  if (want("file"))
    await run(agent, round, tag, "file", sessionKey, () => scenarioFile(ctx, state));
  if (state.fileA) {
    if (want("exec")) await run(agent, round, tag, "exec", sessionKey, () => scenarioExec(ctx));
    if (want("edit"))
      await run(agent, round, tag, "edit", sessionKey, () => scenarioEdit(ctx, state));
    if (want("error")) await run(agent, round, tag, "error", sessionKey, () => scenarioError(ctx));
    if (want("chain"))
      await run(agent, round, tag, "chain", sessionKey, () => scenarioChain(ctx, state));
    if (want("recall"))
      await run(agent, round, tag, "recall", sessionKey, () =>
        scenarioRecall(ctx, state, "in context"),
      );
    if (want("compact"))
      await run(agent, round, tag, "compact", sessionKey, () => scenarioCompact(ctx, state));
    if (want("abort")) await run(agent, round, tag, "abort", sessionKey, () => scenarioAbort(ctx));
    if (want("subagent") && (only?.has("subagent") || round % 3 === 1))
      await run(agent, round, tag, "subagent", sessionKey, () => scenarioSubagent(ctx));
  }
  if (want("stream")) {
    const key = `agent:${agent.id}:soak-chat-${stamp}`;
    await run(agent, round, tag, "stream", key, () => scenarioStream(agent, key));
  }
  if (want("bigread") && agent.bigKb > 0) {
    let key = "";
    await run(agent, round, tag, "bigread", `agent:${agent.id}:soak-long-${tag}`, async () => {
      const result = await scenarioBigRead(agent, tag);
      key = result.key;
      return result.checks;
    });
    void key;
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cfg = loadConfig();
  const specs = (args.agents ?? "drill-haiku").split(",").map((spec) => {
    const [id, ...opts] = spec.trim().split(":");
    const every = Number(opts.find((opt) => opt.startsWith("every="))?.slice(6) ?? 1);
    return { id: id!, every: Number.isFinite(every) && every > 0 ? every : 1 };
  });
  const rounds = Number(args.rounds ?? 1);
  const sleepMinutes = Number(args["sleep-minutes"] ?? 0);
  const maxUsd = Number(args["max-usd"] ?? 5);
  const tag = args.tag ?? new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const only = args.only ? new Set(args.only.split(",")) : undefined;

  for (let round = 1; round <= rounds; round++) {
    // Config is re-read every round: engine and policy can change under a soak.
    const now = loadConfig();
    const agents: AgentInfo[] = specs.map(({ id, every }) => {
      const entry = (now.agents?.list ?? []).find((agent) => agent.id === id);
      if (!entry) {
        throw new Error(`agent ${id} is not in agents.list`);
      }
      const model =
        typeof entry.model === "string" ? entry.model : (entry.model?.primary ?? "default");
      const compaction =
        (entry as { compaction?: { policy?: string } }).compaction?.policy ??
        now.agents?.defaults?.compaction?.policy ??
        "summary";
      return {
        every,
        id,
        workspace: resolveAgentWorkspaceDir(now, id),
        engine: resolveRuntimeEngine(now, id),
        policy: compaction,
        model,
        bigKb: args["big-kb"] !== undefined ? Number(args["big-kb"]) : /haiku/.test(model) ? 54 : 0,
      };
    });
    for (const agent of agents) {
      if ((round - 1) % agent.every !== 0) {
        continue;
      }
      const spent = spentUsd(agent.id);
      if (spent >= maxUsd) {
        console.log(`SKIP ${agent.id}: soak spend $${spent.toFixed(2)} reached the cap $${maxUsd}`);
        continue;
      }
      try {
        await roundFor(agent, round, tag, only);
      } catch (err) {
        console.log(`ROUND ERROR ${agent.id} r${round}: ${String(err).slice(0, 300)}`);
      }
      console.log(`     ${agent.id} soak spend so far: $${spentUsd(agent.id).toFixed(3)}`);
    }
    if (round < rounds && sleepMinutes > 0) {
      await sleep(sleepMinutes * 60_000);
    }
  }
  void cfg;
  process.exit(0);
}

await main();
