/**
 * Source of the RLM sandbox child process (see sandbox.ts for the design).
 *
 * This file only holds JavaScript TEXT. The gateway never evaluates it: it is
 * piped to a separate `node` process on stdin. Two layers live in it:
 *
 *   - BOOTSTRAP_SOURCE runs inside the vm realm and defines every helper the
 *     model-written code can see.
 *   - CHILD_MAIN_SOURCE is the child's own (trusted) code: it owns the vm
 *     context and relays the bridge over the IPC channel.
 */

import { IMPORT_REFUSAL_MESSAGE, REALM_LOCKDOWN_SOURCE } from "../vm-realm-hardening.js";

/**
 * Evaluated once per vm context. Strict mode matters: it removes
 * `fn.caller` / `fn.arguments`, the only way sandbox code could otherwise walk
 * from its own frame to the closure that holds the two host functions.
 *
 * Invariants to keep when editing this:
 *   - `hostSync` / `hostAsync` are only ever CALLED directly. Never store them
 *     on an object, never pass them as an argument, never return them.
 *   - Every host call sits in a try/catch that discards the caught value (a
 *     host-realm error, e.g. a stack overflow raised inside the host frame,
 *     must not reach sandbox code).
 *   - Anything received from the host is used only if it is a string.
 *   - Intrinsics used on the bridge path are captured up front, so sandbox
 *     code that patches a prototype only breaks its own helpers.
 */
export const BOOTSTRAP_SOURCE = String.raw`"use strict";
(function (hostSync, hostAsync, liveApiNames) {
  const G = globalThis;
  const Err = Error;
  const Str = String;
  const P = Promise;
  const apply = Reflect.apply;
  const pResolve = Promise.resolve;
  const pThen = Promise.prototype.then;
  const jsonStringify = JSON.stringify;
  const jsonParse = JSON.parse;
  const isArray = Array.isArray;
  const defineProperty = Object.defineProperty;
  const objectKeys = Object.keys;
  const storeMap = new Map();
  const mapGet = Map.prototype.get;
  const mapSet = Map.prototype.set;
  const mapHas = Map.prototype.has;
  const mapClear = Map.prototype.clear;
  const mapForEach = Map.prototype.forEach;

  function callSync(op, a, b) {
    try {
      hostSync(op, a, b);
    } catch (_hostError) {
      throw new Err("sandbox bridge failure");
    }
  }

  // Returns a realm Promise for the JSON text the host answers with.
  function callAsync(op, payload) {
    const settled = new P(function (resolve) {
      try {
        hostAsync(op, payload, function (error, result) {
          resolve([
            typeof error === "string" ? error : null,
            typeof result === "string" ? result : null,
          ]);
        });
      } catch (_hostError) {
        resolve(["sandbox bridge failure", null]);
      }
    });
    // The Error is created in this microtask, not under the host's frame.
    return apply(pThen, settled, [
      function (pair) {
        if (pair[0] !== null) {
          throw new Err(pair[0]);
        }
        return pair[1] === null ? undefined : jsonParse(pair[1]);
      },
    ]);
  }

  function describeError(e) {
    try {
      if (e !== null && typeof e === "object" && typeof e.message === "string") {
        const name = typeof e.name === "string" && e.name !== "Error" ? e.name + ": " : "";
        return name + e.message;
      }
      return Str(e);
    } catch (_e) {
      return "error";
    }
  }

  function joinArgs(args) {
    let out = "";
    for (let i = 0; i < args.length; i++) {
      out += (i === 0 ? "" : " ") + Str(args[i]);
    }
    return out;
  }

  function define(name, value) {
    defineProperty(G, name, { value: value, writable: true, configurable: true, enumerable: false });
  }

  // --- Output capture ---
  define("print", function (...args) {
    callSync("print", joinArgs(args));
  });
  define("console", {
    log: function (...args) {
      callSync("print", joinArgs(args));
    },
    info: function (...args) {
      callSync("print", joinArgs(args));
    },
    error: function (...args) {
      callSync("print", "ERROR: " + joinArgs(args));
    },
    warn: function (...args) {
      callSync("print", "WARN: " + joinArgs(args));
    },
  });

  // --- LLM recursive sub-calls ---
  function optionalText(value) {
    return value === undefined || value === null ? undefined : Str(value);
  }
  define("llm_query", function (prompt, subContext) {
    return callAsync(
      "llm_query",
      jsonStringify({ prompt: Str(prompt), context: optionalText(subContext) }),
    );
  });
  define("llm_query_parallel", function (queries) {
    if (!isArray(queries)) {
      return apply(pResolve, P, [undefined]).then(function () {
        throw new TypeError("llm_query_parallel expects an array of { prompt, context }");
      });
    }
    const normalized = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i] || {};
      normalized[i] = { prompt: Str(q.prompt), context: optionalText(q.context) };
    }
    return callAsync("llm_query_parallel", jsonStringify(normalized));
  });

  // --- Live data access (only the ones the host provides) ---
  if (liveApiNames.indexOf("search") !== -1) {
    define("search", function (query, opts) {
      const max = opts !== null && typeof opts === "object" ? Number(opts.maxResults) : NaN;
      return callAsync(
        "search",
        jsonStringify({ query: Str(query), maxResults: max === max ? max : null }),
      );
    });
  }
  if (liveApiNames.indexOf("loadTranscript") !== -1) {
    define("loadTranscript", function (sessionId) {
      return callAsync("loadTranscript", jsonStringify({ sessionId: Str(sessionId) }));
    });
  }
  if (liveApiNames.indexOf("listSessions") !== -1) {
    define("listSessions", function () {
      return callAsync("listSessions", "{}");
    });
  }

  // --- Text utilities ---
  function toRegExp(pattern) {
    return typeof pattern === "string" ? new RegExp(pattern, "gi") : pattern;
  }
  define("chunk", function (text, size, overlap) {
    if (!text || size <= 0) {
      return [];
    }
    const step = Math.max(1, size - (overlap || 0));
    const chunks = [];
    for (let i = 0; i < text.length; i += step) {
      chunks.push(text.slice(i, i + size));
    }
    return chunks;
  });
  define("grep", function (text, pattern) {
    const re = toRegExp(pattern);
    return text.split("\n").filter(function (line) {
      return re.test(line);
    });
  });
  define("len", function (text) {
    return text.length;
  });
  define("lineCount", function (text) {
    return text ? text.split("\n").length : 0;
  });
  define("getLines", function (text, from, to) {
    const lines = text.split("\n");
    const start = Math.max(0, from - 1);
    const end = to !== undefined ? Math.min(lines.length, to) : lines.length;
    return lines.slice(start, end).join("\n");
  });
  define("extractAll", function (text, pattern) {
    const matches = text.match(toRegExp(pattern));
    return matches ? Array.from(new Set(matches)) : [];
  });
  define("countMatches", function (text, pattern) {
    const matches = text.match(toRegExp(pattern));
    return matches ? matches.length : 0;
  });
  define("textStats", function (text) {
    return {
      chars: text.length,
      lines: text.split("\n").length,
      words: text.split(/\s+/).filter(Boolean).length,
    };
  });
  define("slice", function (text, start, end) {
    return text.slice(start, end);
  });
  define("split", function (text, sep) {
    return text.split(sep);
  });
  define("join", function (arr, sep) {
    return arr.join(sep);
  });
  define("includes", function (text, sub) {
    return text.includes(sub);
  });
  define("indexOf", function (text, sub, from) {
    return text.indexOf(sub, from);
  });
  define("replace", function (text, pattern, replacement) {
    return text.replace(pattern, replacement);
  });
  define("toLowerCase", function (text) {
    return text.toLowerCase();
  });
  define("toUpperCase", function (text) {
    return text.toUpperCase();
  });
  define("trim", function (text) {
    return text.trim();
  });
  define("startsWith", function (text, prefix) {
    return text.startsWith(prefix);
  });
  define("endsWith", function (text, suffix) {
    return text.endsWith(suffix);
  });

  // --- Persistent storage across code blocks (lives in the realm) ---
  define("store", function (name, value) {
    apply(mapSet, storeMap, [name, value]);
    return value;
  });
  define("get", function (name) {
    return apply(mapGet, storeMap, [name]);
  });
  define("has", function (name) {
    return apply(mapHas, storeMap, [name]);
  });

  // --- Completion signals ---
  define("FINAL", function (answer) {
    callSync("final", Str(answer));
  });
  define("FINAL_VAR", function (varName) {
    callSync("finalVar", Str(varName));
  });

  // --- Run driver. The host never awaits a realm promise: the realm reports
  // completion itself. One-shot per arm(), keyed by run id, so a stray call
  // or a late finish from an abandoned run cannot settle the current one. ---
  let armedRun = null;
  defineProperty(G, "__rlm_run", {
    value: function (fn) {
      const runId = armedRun;
      if (runId === null) {
        throw new Err("__rlm_run is reserved for the sandbox driver");
      }
      armedRun = null;
      let result;
      try {
        result = fn();
      } catch (e) {
        callSync("fail", runId, describeError(e));
        return;
      }
      apply(pThen, apply(pResolve, P, [result]), [
        function () {
          callSync("done", runId);
        },
        function (e) {
          callSync("fail", runId, describeError(e));
        },
      ]);
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });

  // --- Host-facing API (realm functions; primitives in, primitives out) ---
  return {
    setContext: function (text) {
      G.context = text;
    },
    arm: function (runId) {
      armedRun = Str(runId);
    },
    storeExport: function () {
      const out = {};
      apply(mapForEach, storeMap, [
        function (value, key) {
          try {
            const encoded = jsonStringify(value);
            if (typeof encoded === "string") {
              out[Str(key)] = jsonParse(encoded);
            }
          } catch (_e) {
            // Skip non-serializable entries
          }
        },
      ]);
      return jsonStringify(out);
    },
    storeImport: function (json) {
      const data = jsonParse(json);
      if (data === null || typeof data !== "object") {
        return;
      }
      const keys = objectKeys(data);
      for (let i = 0; i < keys.length; i++) {
        if (!apply(mapHas, storeMap, [keys[i]])) {
          apply(mapSet, storeMap, [keys[i], data[keys[i]]]);
        }
      }
    },
    storeClear: function () {
      apply(mapClear, storeMap, []);
    },
    varString: function (name) {
      const value = apply(mapGet, storeMap, [name]);
      return value === undefined ? undefined : Str(value);
    },
    varJson: function (name) {
      const encoded = jsonStringify(apply(mapGet, storeMap, [name]));
      return typeof encoded === "string" ? encoded : undefined;
    },
  };
});
`;

/**
 * The child's main program (CommonJS, read from stdin). Messages:
 *
 *   parent -> child
 *     { t: "init", context, liveApiNames, store }   build / rebuild the realm
 *     { t: "exec", id, code, timeout, resetFinal, importStore }
 *     { t: "reply", callId, error, result }         answer to a bridged call
 *   child -> parent
 *     { t: "ready" }                                process is up
 *     { t: "print" | "final" | "finalVar", text }
 *     { t: "call", callId, op, payload }            llm_query, search, ...
 *     { t: "done", id, error, store, finalVar }     run finished + store snapshot
 *
 * Everything the child sends is treated as untrusted by the parent.
 */
const CHILD_MAIN_SOURCE = String.raw`const vm = require("node:vm");
const IMPORT_TOKEN = /\bimport\b/;
const MAX_OUTPUT_CHARS = 1000000;
const BOOTSTRAP_TIMEOUT_MS = 5000;

let ctx = null;
let realm = null;
let epoch = 0;
let pendingRun = null;
let finalVarName = null;
let outChars = 0;
let truncated = false;
let callSeq = 0;
let calls = new Map();

function send(message) {
  try {
    process.send(message);
  } catch (_e) {
    // Parent is gone; the disconnect handler exits.
  }
}

function errText(e) {
  try {
    if (e !== null && typeof e === "object" && typeof e.message === "string") {
      return e.message;
    }
    return String(e);
  } catch (_e) {
    return "error";
  }
}

function finish(id, error) {
  let store = "{}";
  let finalVar = null;
  try {
    const exported = realm.storeExport();
    if (typeof exported === "string") {
      store = exported;
    }
  } catch (_e) {}
  if (finalVarName !== null) {
    try {
      const value = realm.varString(finalVarName);
      if (typeof value === "string") {
        finalVar = value;
      }
    } catch (_e) {}
  }
  send({ t: "done", id: id, error: error, store: store, finalVar: finalVar });
}

// Synchronous half of the bridge. Called from realm code: never throws,
// returns undefined only.
function hostSync(op, a, b) {
  try {
    const text = typeof a === "string" ? a : "";
    if (op === "print") {
      if (outChars < MAX_OUTPUT_CHARS) {
        outChars += text.length + 1;
        send({ t: "print", text: text });
      } else if (!truncated) {
        truncated = true;
        send({ t: "print", text: "[... output truncated: sandbox output cap reached ...]" });
      }
    } else if (op === "final") {
      send({ t: "final", text: text });
    } else if (op === "finalVar") {
      finalVarName = text;
      send({ t: "finalVar", text: text });
    } else if (op === "done" || op === "fail") {
      if (pendingRun !== null && pendingRun === text) {
        pendingRun = null;
        finish(text, op === "done" ? null : typeof b === "string" ? b : "error");
      }
    }
  } catch (_e) {}
  return undefined;
}

// Asynchronous half: the realm callback is answered with strings only.
function hostAsync(op, payload, cb) {
  try {
    if (typeof cb !== "function") {
      return undefined;
    }
    const callId = ++callSeq;
    calls.set(callId, cb);
    send({
      t: "call",
      callId: callId,
      op: String(op),
      payload: typeof payload === "string" ? payload : "{}",
    });
  } catch (_e) {}
  return undefined;
}

function build(message) {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(LOCKDOWN_SOURCE, context, { timeout: BOOTSTRAP_TIMEOUT_MS });
  const init = vm.runInContext(BOOTSTRAP_SOURCE, context, {
    timeout: BOOTSTRAP_TIMEOUT_MS,
    filename: "rlm-sandbox-bootstrap.js",
  });
  // Bridge functions handed to an older realm go inert on rebuild.
  const mine = ++epoch;
  calls = new Map();
  pendingRun = null;
  finalVarName = null;
  const api = init(
    function (op, a, b) {
      return mine === epoch ? hostSync(op, a, b) : undefined;
    },
    function (op, payload, cb) {
      return mine === epoch ? hostAsync(op, payload, cb) : undefined;
    },
    typeof message.liveApiNames === "string" ? message.liveApiNames : "",
  );
  api.setContext(typeof message.context === "string" ? message.context : "");
  if (typeof message.store === "string") {
    try {
      api.storeImport(message.store);
    } catch (_e) {}
  }
  ctx = context;
  realm = api;
}

function exec(message) {
  const id = String(message.id);
  const code = typeof message.code === "string" ? message.code : "";
  outChars = 0;
  truncated = false;
  if (message.resetFinal === true) {
    finalVarName = null;
  }
  if (typeof message.importStore === "string") {
    try {
      realm.storeImport(message.importStore);
    } catch (_e) {}
  }
  if (IMPORT_TOKEN.test(code)) {
    finish(id, IMPORT_REFUSAL);
    return;
  }
  try {
    const script = new vm.Script("__rlm_run(async () => {\n" + code + "\n})", {
      filename: "rlm-sandbox.js",
    });
    pendingRun = id;
    realm.arm(id);
    script.runInContext(ctx, { timeout: Number(message.timeout) || 30000 });
  } catch (e) {
    if (pendingRun === id) {
      pendingRun = null;
    }
    finish(id, errText(e));
  }
}

process.on("message", function (message) {
  if (message === null || typeof message !== "object") {
    return;
  }
  try {
    if (message.t === "init") {
      build(message);
    } else if (message.t === "exec") {
      exec(message);
    } else if (message.t === "reply") {
      const cb = calls.get(message.callId);
      if (cb) {
        calls.delete(message.callId);
        cb(
          typeof message.error === "string" ? message.error : null,
          typeof message.result === "string" ? message.result : null,
        );
      }
    }
  } catch (e) {
    if (message.t === "exec") {
      send({ t: "done", id: String(message.id), error: errText(e), store: null, finalVar: null });
    }
  }
});
// Model-written code may reject promises nobody awaits or throw from odd
// places; neither may take the sandbox process down mid-run.
process.on("unhandledRejection", function () {});
process.on("uncaughtException", function () {});
process.on("disconnect", function () {
  process.exit(0);
});
send({ t: "ready" });
`;

/** Complete program piped to the sandbox child on stdin. */
export const SANDBOX_CHILD_SOURCE =
  `"use strict";\n` +
  `const LOCKDOWN_SOURCE = ${JSON.stringify(REALM_LOCKDOWN_SOURCE)};\n` +
  `const BOOTSTRAP_SOURCE = ${JSON.stringify(BOOTSTRAP_SOURCE)};\n` +
  `const IMPORT_REFUSAL = ${JSON.stringify(IMPORT_REFUSAL_MESSAGE)};\n` +
  CHILD_MAIN_SOURCE;
