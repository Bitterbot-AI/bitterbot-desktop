import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export const model = "claude-sonnet-4-6";
export const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 };
export const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export function usageCost(usage) {
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ])
    if (
      !Number.isFinite(usage?.[key] ?? (key.startsWith("cache_") ? 0 : NaN)) ||
      (usage[key] ?? 0) < 0
    )
      throw Error("Missing or invalid usage receipt");
  const writes = usage.cache_creation_input_tokens ?? 0;
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  if (!Number.isFinite(hour) || hour < 0 || hour > writes) throw Error("Invalid cache usage");
  return (
    (usage.input_tokens * rates.input +
      usage.output_tokens * rates.output +
      (usage.cache_read_input_tokens ?? 0) * rates.cacheRead +
      (writes - hour) * rates.cacheWrite +
      hour * rates.cacheWrite1h) /
    1e6
  );
}

export function priorExposure(resultsRoot) {
  const rows = [];
  for (const entry of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(resultsRoot, entry.name, "provider.jsonl");
    if (!fs.existsSync(file)) continue;
    const ledger = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const receipts = new Map(ledger.filter((r) => r.type === "receipt").map((r) => [r.id, r]));
    for (const intent of ledger.filter((r) => r.type === "intent")) {
      const receipt = receipts.get(intent.id);
      rows.push({
        run: entry.name,
        id: intent.id,
        usd: receipt?.usd ?? intent.quote,
        unresolved: !receipt,
      });
    }
  }
  return rows;
}

/** Serial native-tool Messages calls. Durable intent, no retries, shared ceiling. */
export function createProvider(root, ceiling, transport = fetch) {
  dotenv.config({ quiet: true });
  fs.mkdirSync(path.join(root, "responses"), { recursive: true });
  let spent = 0,
    reserved = 0,
    unresolved = 0,
    active = false;
  const append = (row) => {
    const fd = fs.openSync(path.join(root, "provider.jsonl"), "a");
    try {
      fs.writeSync(fd, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const quote = (body) =>
    ((Buffer.byteLength(JSON.stringify(body)) + 8192) * 6 + body.max_tokens * 15) / 1e6;
  return {
    status: () => ({ spent, reserved, unresolved, ceiling, active }),
    async call(request, { tag, signal, maxTokens = 1024, localRemaining = Infinity } = {}) {
      if (active || unresolved) throw Error("Active request or unresolved liability");
      if (!process.env.ANTHROPIC_API_KEY) throw Error("Missing Anthropic credential");
      const body = { model, max_tokens: maxTokens, ...request };
      if (
        body.model !== model ||
        body.max_tokens !== maxTokens ||
        !Number.isInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > 4096
      )
        throw Error("Invalid model or token budget");
      if (Buffer.byteLength(JSON.stringify(body)) > 140000) throw Error("Prompt exceeds bound");
      const liability = quote(body);
      if (spent + liability > ceiling || liability > localRemaining)
        throw Error("Study provider ceiling reached");
      const id = crypto.randomUUID(),
        started = performance.now();
      active = true;
      reserved = liability;
      let settled = false;
      try {
        append({
          type: "intent",
          id,
          tag,
          model,
          quote: liability,
          promptHash: hash(body),
          maxTokens,
        });
        const response = await transport("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
            : AbortSignal.timeout(90000),
        });
        const result = await response.json();
        fs.writeFileSync(
          path.join(root, "responses", `${id}.json`),
          JSON.stringify(
            { tag, request: body, status: response.status, response: result },
            null,
            2,
          ),
          { flag: "wx" },
        );
        if (!response.ok || result.model !== model)
          throw Error(`Unpriced or mismatched provider response: ${response.status}`);
        const usd = usageCost(result.usage),
          wallMs = performance.now() - started;
        append({
          type: "receipt",
          id,
          tag,
          model,
          usd,
          wallMs,
          usage: result.usage,
          stopReason: result.stop_reason,
          requestId: response.headers.get("request-id"),
        });
        spent += usd;
        reserved = 0;
        settled = true;
        if (usd > liability) throw Error("Provider reservation overrun");
        return { id, usd, wallMs, content: result.content, stopReason: result.stop_reason };
      } catch (error) {
        if (!settled) {
          unresolved++;
          append({ type: "interrupted", id, reason: error.message });
        }
        throw error;
      } finally {
        active = false;
      }
    },
  };
}
