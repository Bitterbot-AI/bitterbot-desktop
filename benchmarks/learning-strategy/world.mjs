import { createHash } from "node:crypto";
export const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function hypotheses(domain, version = 1) {
  const out = [];
  if (domain === "numeric")
    for (const a of [1, 2, 3])
      for (const b of [-2, 1])
        for (const d of version === 1 ? [2, 3] : [3, 5])
          for (const rounding of ["floor", "ceil"])
            out.push({ id: `h${out.length}`, a, b, d, rounding });
  else
    for (const order of ["ascending", "descending", "arrival"])
      for (const unique of ["first", "last"])
        for (const casing of ["lower", "upper"])
          for (const stage of ["before", "after"])
            out.push({ id: `h${out.length}`, order, unique, casing, stage });
  return out;
}
/** Simulator is the tool available to the actor. It has no filesystem/network capability. */
export function apply(domain, h, input) {
  if (domain === "numeric") return Math[h.rounding]((input * h.a + h.b) / h.d) || 0;
  let values = [...input];
  const change = (x) => (h.casing === "lower" ? x.toLowerCase() : x.toUpperCase());
  if (h.stage === "before") values = values.map(change);
  values = values.filter((x, i) =>
    h.unique === "first" ? values.indexOf(x) === i : values.lastIndexOf(x) === i,
  );
  if (h.stage === "after") values = values.map(change);
  if (h.order !== "arrival") values.sort();
  if (h.order === "descending") values.reverse();
  return values;
}
/** Separate reference implementation for the final oracle. Never sent to a model. */
export function reference(domain, h, input) {
  if (domain === "numeric") {
    const n = input * h.a + h.b,
      q = Math.trunc(n / h.d),
      r = n % h.d;
    return q + (r === 0 ? 0 : h.rounding === "floor" ? (n < 0 ? -1 : 0) : n > 0 ? 1 : 0) || 0;
  }
  const result = [],
    seen = new Set(),
    change = (x) => (h.casing === "lower" ? x.toLowerCase() : x.toUpperCase());
  const indices = Array.from({ length: input.length }, (_, i) => i);
  if (h.unique === "last") indices.reverse();
  for (const i of indices) {
    const key = h.stage === "before" ? change(input[i]) : input[i];
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  if (h.unique === "last") result.reverse();
  const output = h.stage === "after" ? result.map(change) : result;
  if (h.order === "arrival") return output;
  return output.sort((a, b) =>
    a === b ? 0 : (a < b ? -1 : 1) * (h.order === "descending" ? -1 : 1),
  );
}
export const queryPool = (domain) =>
  domain === "numeric"
    ? Array.from({ length: 41 }, (_, i) => i - 20)
    : [
        ["a", "B", "a", "A"],
        ["B", "a", "b", "A", "B"],
        ["c", "A", "b", "C", "a"],
        ["a", "A"],
        ["B", "b", "a", "B"],
        ["c", "a", "c", "B", "A"],
      ];
export function makeTasks(domain, seed, split, count, version = 1) {
  const hs = hypotheses(domain, version);
  const permutation = hs
    .map((_, index) => ({ index, key: hash({ seed, domain, version, index }) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const offset = split.includes("held-out") ? 12 : 0;
  return Array.from({ length: count }, (_, i) => ({
    id: `${domain}:${version}:${seed}:${split}:${i}`,
    domain,
    version,
    secret: permutation[(offset + i) % hs.length].index,
    split,
    seed,
  }));
}
export function publicTask(task) {
  return {
    domain: task.domain,
    version: task.version,
    hypotheses: hypotheses(task.domain, task.version),
    queryInputs: queryPool(task.domain),
    probeLimit: 3,
    semantics:
      task.domain === "numeric"
        ? "Each hypothesis maps integer x to rounding((a*x+b)/d). floor means toward negative infinity; ceil toward positive infinity."
        : "Each hypothesis maps a string array: change case before or after deduplication according to stage; keep first or last duplicate according to unique; finally order ascending/descending lexicographically or preserve arrival order. Deduplication compares exact strings at its stage; changing case afterward may reintroduce duplicates.",
    objective:
      "Identify the deployed function. You may query up to three allowed inputs. Submit a hypothesis ID. Success requires matching the deployed function on unseen inputs, not just observed probes.",
  };
}
export function judge(task, id) {
  const hs = hypotheses(task.domain, task.version),
    candidate = hs.find((h) => h.id === id);
  if (!candidate) return false;
  const hidden =
    task.domain === "numeric"
      ? Array.from({ length: 61 }, (_, i) => i - 30)
      : [
          ...queryPool("sequence"),
          ["C", "b", "A", "c", "B", "a"],
          ["a", "b", "a", "c", "b", "A"],
          [],
          ["A"],
        ];
  return hidden.every(
    (input) =>
      JSON.stringify(apply(task.domain, candidate, input)) ===
      JSON.stringify(reference(task.domain, hs[task.secret], input)),
  );
}
/** Strong non-LLM control, using only the public hypotheses and observable tool responses. */
export function diagnosticControl(task) {
  let remaining = hypotheses(task.domain, task.version);
  const queries = queryPool(task.domain),
    secret = remaining[task.secret];
  for (let i = 0; i < 3; i++) {
    const ranked = queries
      .map((input) => {
        const counts = new Map();
        for (const h of remaining) {
          const out = JSON.stringify(apply(task.domain, h, input));
          counts.set(out, (counts.get(out) ?? 0) + 1);
        }
        return { input, score: [...counts.values()].reduce((s, n) => s + n * n, 0) };
      })
      .sort((a, b) => a.score - b.score);
    const input = ranked[0].input,
      observed = JSON.stringify(apply(task.domain, secret, input));
    remaining = remaining.filter((h) => JSON.stringify(apply(task.domain, h, input)) === observed);
  }
  return { id: remaining[0].id, passed: judge(task, remaining[0].id) };
}
export function parseJson(text) {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, ""),
  );
}
export async function act(provider, strategy, task, signal) {
  const history = [],
    requests = [];
  let usd = 0,
    wallMs = 0,
    probes = 0;
  for (let turn = 0; turn < 4; turn++) {
    const prompt = `You operate a versioned black-box tool. Follow the public task contract.\nOperational guidance:\n${strategy.actor}\nTask:\n${JSON.stringify(publicTask(task))}\nObserved actions/results:\n${JSON.stringify(history)}\n${probes === 3 ? "No probes remain; submit now." : "Choose a probe or submit."}\nReturn JSON {"action":"probe" or "submit", "index": integer}. For probe, index is the ZERO-BASED index into queryInputs. For submit, index is the hypothesis number (e.g. 7 means h7). No extra keys or prose.`;
    const response = await provider.call(prompt, {
      tag: `actor:${task.id}`,
      signal,
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["probe", "submit"] },
          index: { type: "integer" },
        },
        required: ["action", "index"],
        additionalProperties: false,
      },
    });
    requests.push(response.id);
    usd += response.usd;
    wallMs += response.wallMs;
    let action;
    try {
      action = parseJson(response.text);
    } catch {
      return {
        output: { id: null, history, requests, invalid: "JSON" },
        cost: { providerUsd: usd, toolCalls: probes, wallMs },
      };
    }
    if (
      !action ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      Object.keys(action).length !== 2 ||
      !Number.isInteger(action.index) ||
      action.index < 0
    )
      break;
    if (action.action === "submit")
      return {
        output: { id: `h${action.index}`, history, requests },
        cost: { providerUsd: usd, toolCalls: probes, wallMs },
      };
    if (probes >= 3 || action.action !== "probe" || action.index >= queryPool(task.domain).length)
      break;
    const result = apply(
      task.domain,
      hypotheses(task.domain, task.version)[task.secret],
      queryPool(task.domain)[action.index],
    );
    history.push({ probe: queryPool(task.domain)[action.index], result });
    probes++;
  }
  return {
    output: { id: null, history, requests, invalid: "action or probe budget" },
    cost: { providerUsd: usd, toolCalls: probes, wallMs },
  };
}
