import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export const model = "claude-sonnet-4-6";
export const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 };
/** One new run directory, one writer, at most three active requests. No implicit retries. */
export function createProvider(root, ceiling = 10) {
  dotenv.config({ quiet: true });
  const ledgerFile = path.join(root, "provider.jsonl"),
    responseDir = path.join(root, "responses");
  fs.mkdirSync(responseDir, { recursive: true });
  let active = 0,
    spent = 0,
    reserved = 0,
    unresolved = 0;
  const waiting = [];
  const append = (record) => {
    const fd = fs.openSync(ledgerFile, "a");
    try {
      fs.writeSync(fd, JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const quote = (prompt, maxTokens) =>
    ((Buffer.byteLength(prompt) + 8192) * rates.cacheWrite + maxTokens * rates.output) / 1e6;
  const call = async (prompt, { maxTokens = 1500, tag = "actor", signal, schema } = {}) => {
    if (active >= 3) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    let id,
      liability,
      settled = false;
    try {
      signal?.throwIfAborted();
      if (unresolved) throw Error("Unresolved provider liability; collection stopped");
      if (!process.env.ANTHROPIC_API_KEY) throw Error("Missing Anthropic credential");
      if (Buffer.byteLength(prompt) > 60000) throw Error("Prompt exceeds bound");
      liability = quote(prompt, maxTokens);
      if (spent + reserved + liability > ceiling) throw Error("Study provider ceiling reached");
      id = crypto.randomUUID();
      reserved += liability;
      append({
        type: "intent",
        id,
        tag,
        model,
        quote: liability,
        promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
        maxTokens,
      });
      const started = performance.now();
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
          ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}),
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
          : AbortSignal.timeout(90000),
      });
      const body = await response.json();
      fs.writeFileSync(
        path.join(responseDir, `${id}.json`),
        JSON.stringify({ tag, prompt, schema, status: response.status, response: body }, null, 2),
        { flag: "wx" },
      );
      if (!response.ok)
        throw Error(`Provider response ${response.status}; usage requires reconciliation`);
      const usage = body.usage;
      if (
        body.model !== model ||
        !Number.isFinite(usage?.input_tokens) ||
        !Number.isFinite(usage?.output_tokens)
      )
        throw Error("Missing usage/model receipt");
      const usd =
        (usage.input_tokens * rates.input +
          usage.output_tokens * rates.output +
          (usage.cache_read_input_tokens ?? 0) * rates.cacheRead +
          (usage.cache_creation_input_tokens ?? 0) * rates.cacheWrite) /
        1e6;
      const result = {
        id,
        usd,
        wallMs: performance.now() - started,
        text: body.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
        usage,
        stopReason: body.stop_reason,
      };
      append({
        type: "receipt",
        ...result,
        text: undefined,
        model,
        requestId: response.headers.get("request-id"),
      });
      spent += usd;
      reserved -= liability;
      settled = true;
      if (usd > liability) throw Error("Provider reservation overrun");
      return result;
    } catch (error) {
      if (id && !settled) {
        unresolved++;
        append({ type: "interrupted", id, reason: error.message, cause: error.cause?.code });
      }
      throw error;
    } finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  };
  return {
    call,
    quote,
    status: () => ({
      spent,
      reserved: Math.abs(reserved) < 1e-12 ? 0 : reserved,
      unresolved,
      active,
      ceiling,
      model,
      rates,
    }),
  };
}
