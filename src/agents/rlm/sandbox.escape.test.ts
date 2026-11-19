/**
 * The RLM sandbox runs code written by a sub-LLM that reads attacker-influenced
 * text. Before 2026-11-19 it was seeded with host-realm objects, so
 * `Error.constructor("return process")()` returned the gateway's `process`
 * (security report, same class as the code_interpreter escape of 2026-09-20).
 *
 * Every probe below tries to reach the HOST realm. `typeof process` evaluated
 * through a host Function is "object"; anything else means the probe failed.
 * A probe passes the test when it cannot produce "object".
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyOwnerOnlyToolPolicy, isOwnerOnlyToolName } from "../tool-policy.js";
import { RLMSandbox, sandboxPermissionFlagForTest } from "./sandbox.js";

const sandboxes: RLMSandbox[] = [];

function sandbox(): RLMSandbox {
  const sb = new RLMSandbox({
    context: "some context",
    timeout: 3000,
    onLLMQuery: async (prompt) => `echo:${prompt}`,
    onLLMQueryParallel: async (queries) => queries.map((q) => `echo:${q.prompt}`),
    liveApis: {
      search: async (query) => [{ snippet: `hit ${query}`, score: 1, source: "memory" }],
      loadTranscript: async () => "[t] USER: hi",
      listSessions: async () => {
        throw new Error("db locked");
      },
    },
  });
  sandboxes.push(sb);
  return sb;
}

/** JS (sandbox side) that tries to turn `expr` into the host process. */
function probe(expr: string): string {
  return `
    let verdict = "no-escape";
    try {
      const target = ${expr};
      const F = target.constructor.constructor;
      const proc = F("return typeof process")();
      verdict = "ESCAPED:" + proc;
    } catch (e) {
      verdict = "blocked";
    }
    print(verdict);
  `;
}

afterEach(() => {
  for (const sb of sandboxes.splice(0)) {
    sb.dispose();
  }
});

describe("RLM sandbox: no host realm reachable", () => {
  it("blocks the reported primitive", async () => {
    const result = await sandbox().execute(
      `let v = "blocked"; try { v = "ESCAPED:" + typeof Error.constructor("return process")(); } catch (e) {} print(v);`,
    );
    expect(result.output).toBe("blocked");
  });

  // Each of these was a host-realm object (or returned one) before the fix.
  const targets: Array<[string, string]> = [
    ["an intrinsic", "JSON"],
    ["a class", "Promise"],
    ["print", "print"],
    ["console.log", "console.log"],
    ["a text helper", "grep"],
    ["store", "store"],
    ["FINAL", "FINAL"],
    ["llm_query", "llm_query"],
    ["the llm_query promise", 'llm_query("x")'],
    ["the llm_query result", 'await llm_query("x")'],
    ["the llm_query_parallel result", 'await llm_query_parallel([{ prompt: "a" }])'],
    ["the search promise", 'search("q")'],
    ["the search result array", 'await search("q")'],
    ["a search result row", '(await search("q"))[0]'],
    ["the listSessions error row", "(await listSessions())[0]"],
    ["the run driver", "__rlm_run"],
    ["the global", "globalThis"],
    ["this", "this"],
    ["a helper's return value", 'chunk("abcdef", 2)'],
    ["textStats output", 'textStats("a b")'],
    ["a regexp match list", 'extractAll("a b", "a")'],
  ];
  for (const [label, expr] of targets) {
    it(`cannot pivot through ${label}`, async () => {
      const result = await sandbox().execute(probe(expr));
      expect(result.output).not.toContain("ESCAPED");
      expect(result.output).toBe("blocked");
    });
  }

  it("has no host constructor or host global on the global", async () => {
    const sb = sandbox();
    const result = await sb.execute(
      `print(typeof process, typeof require, typeof Buffer, typeof setTimeout);`,
    );
    expect(result.output).toBe("undefined undefined undefined undefined");
    // A bare `constructor` resolves to the realm's own Object, never the host's.
    expect((await sb.execute(probe("constructor"))).output).toBe("blocked");
    expect((await sb.execute(probe("{ constructor }"))).output).toBe("blocked");
  });

  it("disables eval and Function(string) in the realm", async () => {
    const result = await sandbox().execute(`
      const out = [];
      try { eval("1"); out.push("eval-ran"); } catch (e) { out.push("eval-blocked"); }
      try { (function(){}).constructor("return 1")(); out.push("fn-ran"); } catch (e) { out.push("fn-blocked"); }
      try { (async function(){}).constructor("return 1"); out.push("afn-ran"); } catch (e) { out.push("afn-blocked"); }
      print(out.join(","));
    `);
    expect(result.output).toBe("eval-blocked,fn-blocked,afn-blocked");
  });

  it("values imported into the store are realm objects", async () => {
    const sb = sandbox();
    sb.importStore({ planted: { nested: [1, 2, 3] } });
    const result = await sb.execute(
      `{${probe('get("planted")')}} {${probe('get("planted").nested')}} print(get("planted").nested[2]);`,
    );
    expect(result.output).toBe("blocked\nblocked\n3");
  });

  it("errors thrown by a failing bridge call are realm errors", async () => {
    const sb = new RLMSandbox({
      context: "c",
      timeout: 3000,
      onLLMQuery: async () => {
        throw new Error("provider down");
      },
    });
    sandboxes.push(sb);
    const result = await sb.execute(`
      let caught;
      try { await llm_query("x"); } catch (e) { caught = e; }
      print(caught.message);
      ${probe("caught")}
    `);
    expect(result.output).toBe("provider down\nblocked");
  });

  it("a stack overflow raised around a bridge call does not leak a host error", async () => {
    const result = await sandbox().execute(`
      let verdict = "blocked";
      function dive() {
        try {
          dive();
        } catch (e) {
          try {
            print("x");
            FINAL("x");
            store("k", 1);
          } catch (e2) {
            try {
              if (e2.constructor.constructor("return typeof process")() === "object") {
                verdict = "ESCAPED";
              }
            } catch (e3) {}
          }
          throw e;
        }
      }
      try { dive(); } catch (e) {}
      store("verdict", verdict);
    `);
    expect(result.error).toBeUndefined();
    const sb = sandboxes[sandboxes.length - 1];
    expect(sb.getVariable("verdict")).toBe("blocked");
  });

  it("patched prototypes cannot capture the bridge functions", async () => {
    const result = await sandbox().execute(`
      const seen = [];
      const record = (args) => { for (const a of args) if (typeof a === "function") seen.push(a); };
      const origApply = Reflect.apply, origCall = Function.prototype.call, origBind = Function.prototype.bind;
      const origPush = Array.prototype.push, origStringify = JSON.stringify;
      Reflect.apply = function (f, t, a) { seen.push(f); return origApply(f, t, a); };
      Array.prototype.push = function (...a) { record(a); return origApply(origPush, this, a); };
      JSON.stringify = function (...a) { record(a); return origApply(origStringify, JSON, a); };
      print("a"); console.log("b"); FINAL("z"); store("k", 1);
      await llm_query("x"); await search("q"); await llm_query_parallel([{ prompt: "p" }]);
      Reflect.apply = origApply; Array.prototype.push = origPush; JSON.stringify = origStringify;
      let escaped = 0;
      for (const f of seen) {
        try { if (f.constructor("return typeof process")() === "object") escaped++; } catch (e) {}
      }
      store("escaped", escaped);
    `);
    expect(result.error).toBeUndefined();
    const sb = sandboxes[sandboxes.length - 1];
    expect(sb.getVariable("escaped")).toBe(0);
  });

  it("the host never calls a sandbox-patched then() with host functions", async () => {
    const sb = sandbox();
    const result = await sb.execute(`
      const AsyncProto = Object.getPrototypeOf((async () => {})());
      const orig = AsyncProto.then;
      globalThis.thenLeak = "blocked";
      AsyncProto.then = function (a, b) {
        for (const f of [a, b]) {
          try {
            if (typeof f === "function" && f.constructor("return typeof process")() === "object") {
              globalThis.thenLeak = "ESCAPED";
            }
          } catch (e) {}
        }
        return orig.call(this, a, b);
      };
    `);
    expect(result.error).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await sb.execute(`print(globalThis.thenLeak);`);
    expect(after.output).toBe("blocked");
  });

  it("breaking out of the async wrapper stays inside the realm", async () => {
    const result = await sandbox().execute(
      `}); let v = "blocked"; try { v = "ESCAPED:" + typeof this.constructor.constructor("return process")(); } catch (e) {} print(v); (async () => {`,
    );
    expect(result.output).not.toContain("ESCAPED");
  });

  it("the run driver cannot be replaced or invoked out of turn", async () => {
    const sb = sandbox();
    const result = await sb.execute(`
      const out = [];
      try { __rlm_run(async () => {}); out.push("ran"); } catch (e) { out.push("refused"); }
      try { globalThis.__rlm_run = () => {}; } catch (e) {}
      try { delete globalThis.__rlm_run; } catch (e) {}
      print(out.join(","));
    `);
    expect(result.output).toBe("refused");
    const next = await sb.execute(`print("still works");`);
    expect(next.output).toBe("still works");
    expect(next.error).toBeUndefined();
  });
});

describe("RLM sandbox: Node host callbacks (red-team pass)", () => {
  const SHOW = `try { print("ESCAPED:" + typeof e.constructor.constructor("return process")()); } catch (x) { print("blocked"); }`;

  it("refuses source containing the import keyword", async () => {
    const sb = sandbox();
    for (const code of [
      `try { await import("x"); } catch (e) { ${SHOW} }`,
      `try { await import /* c */ ("x"); } catch (e) { ${SHOW} }`,
      `}); import("x").catch((e) => { ${SHOW} }); (async () => {`,
    ]) {
      const result = await sb.execute(code);
      expect(result.error).toMatch(/"import" cannot appear/);
      expect(result.output).toBe("");
    }
    // Words that merely contain it are fine.
    expect((await sb.execute(`print("important", "reimport_x");`)).output).toBe(
      "important reimport_x",
    );
  });

  it("the stack formatter cannot be made to throw a host error", async () => {
    const result = await sandbox().execute(`
      const attempts = [
        () => { const err = new Error("x"); err.name = Symbol(); return err.stack; },
        () => { const o = { name: Symbol() }; Error.captureStackTrace(o); return o.stack; },
        () => { const err = new TypeError("x"); err.message = { toString() { return {}; } }; return err.stack; },
        () => { class X extends RangeError { get name() { return Symbol(); } } return new X("x").stack; },
      ];
      for (const attempt of attempts) {
        try { print(typeof attempt()); } catch (e) { ${SHOW} }
      }
    `);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("undefined\nundefined\nundefined\nundefined");
  });

  it("has no FinalizationRegistry (its callbacks throw into the host)", async () => {
    const result = await sandbox().execute(`print(typeof FinalizationRegistry);`);
    expect(result.output).toBe("undefined");
  });

  it("stack capture cannot be re-enabled", async () => {
    const result = await sandbox().execute(`
      try { Error.stackTraceLimit = 50; } catch (e) {}
      try { Error.prepareStackTrace = () => "x"; } catch (e) {}
      try { Object.defineProperty(Error, "stackTraceLimit", { value: 50 }); } catch (e) {}
      try { delete Error.stackTraceLimit; } catch (e) {}
      print(String(Error.stackTraceLimit), String(Error.prepareStackTrace), typeof new Error("x").stack);
    `);
    expect(result.output).toBe("undefined undefined undefined");
  });

  it("no host error surfaces anywhere near stack exhaustion", async () => {
    const sb = sandbox();
    const result = await sb.execute(`
      let hostErrors = 0, caught = 0;
      const actions = [
        () => new Error("x").stack,
        () => { const o = {}; Error.captureStackTrace(o); return o.stack; },
        () => print("x"),
        () => { const p = llm_query("x"); p.catch(() => {}); return p; },
        () => { const p = search("q"); p.catch(() => {}); return p; },
        () => JSON.parse("{"),
        () => null.x,
        () => new RegExp("("),
      ];
      function dive(action) {
        try {
          dive(action);
        } catch (e0) {
          try { action(); } catch (e) {
            caught++;
            try {
              if (e.constructor.constructor("return typeof process")() === "object") hostErrors++;
            } catch (_) {}
          }
          throw e0;
        }
      }
      for (const action of actions) { try { dive(action); } catch (_) {} }
      store("hostErrors", hostErrors);
      store("caught", caught);
    `);
    expect(result.error).toBeUndefined();
    expect(sb.getVariable("caught")).toBeGreaterThan(0);
    expect(sb.getVariable("hostErrors")).toBe(0);
  });
});

describe("RLM sandbox: host side is not confused by realm values", () => {
  it("execute() never rejects, whatever is thrown", async () => {
    const sb = sandbox();
    const result = await sb.execute(`}); throw { toString() { return {}; } }; (async () => {`);
    expect(typeof result.error).toBe("string");
    expect((await sb.execute(`throw { toString() { throw 1; } };`)).error).toBe("error");
  });

  it("forged bridge payloads reach host handlers as plain strings", async () => {
    const calls: unknown[][] = [];
    const sb = new RLMSandbox({
      context: "c",
      timeout: 3000,
      onLLMQuery: async (...args) => {
        calls.push(args);
        return "r";
      },
      liveApis: {
        search: async (...args) => {
          calls.push(args);
          return [];
        },
        loadTranscript: async (...args) => {
          calls.push(args);
          return null;
        },
      },
    });
    sandboxes.push(sb);
    await sb.execute(`
      const bare = (props) => Object.assign(Object.create(null), props);
      const evil = bare({ prompt: bare({ a: 1 }), context: 7, query: bare({ q: 1 }), maxResults: "999", sessionId: 42 });
      Object.prototype.toJSON = function () { return evil; };
      try { await llm_query("x"); } catch (e) {}
      try { await search("q"); } catch (e) {}
      try { await loadTranscript("s"); } catch (e) {}
      Array.prototype.toJSON = () => "notarray";
      try { await llm_query_parallel([{ prompt: "p" }]); } catch (e) { print("parallel refused"); }
    `);
    expect(calls).toEqual([["", undefined], ["", { maxResults: 10 }], [""]]);
    expect(sb.getLastOutput()).toBe("parallel refused");
  });

  it("updateContext survives a pinned context global and drops realm poisoning", async () => {
    const sb = sandbox();
    await sb.execute(`store("keep", { n: 1 });`);
    await sb.execute(
      `}); const print = () => {}; let context = "evil"; Array.prototype.join = () => "poisoned"; (async () => {`,
    );
    await sb.execute(
      `Object.defineProperty(globalThis, "context", { value: "pinned", writable: false, configurable: false });`,
    );
    expect(() => sb.updateContext("fresh-context")).not.toThrow();
    const result = await sb.execute(`print(context, [1, 2].join("-"), get("keep").n);`);
    expect(result.output).toBe("fresh-context 1-2 1");
  });

  it("code left running in a disposed or rebuilt realm loses the bridge", async () => {
    let calls = 0;
    const sb = new RLMSandbox({
      context: "c",
      timeout: 3000,
      onLLMQuery: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "r";
      },
    });
    sandboxes.push(sb);
    await sb.execute(
      `(async () => { for (let i = 0; i < 1e6; i++) { await llm_query("bg"); FINAL("LATE-HIJACK"); } })(); print("returned");`,
    );
    sb.updateContext("next");
    sb.clearFinal();
    const before = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls - before).toBeLessThanOrEqual(1);
    expect(sb.resolveFinalAnswer()).toBeNull();
    sb.dispose();
    const afterDispose = calls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(afterDispose);
  });
});

describe("RLM sandbox: process isolation", () => {
  it("starts the sandbox process under the Node permission model", () => {
    expect(sandboxPermissionFlagForTest()).toMatch(/^--(experimental-)?permission$/);
  });

  it("a loop that spins after an await is killed, and the store survives", async () => {
    const sb = new RLMSandbox({ context: "c", timeout: 300, onLLMQuery: async () => "x" });
    sandboxes.push(sb);
    await sb.execute(`store("kept", "yes");`);
    const started = Date.now();
    const result = await sb.execute(`store("lost", 1); await llm_query("x"); while (true) {}`);
    expect(result.error).toMatch(/timed out/i);
    // The gateway's own event loop kept running: this await returned on time.
    expect(Date.now() - started).toBeLessThan(15_000);
    const next = await sb.execute(`print(get("kept"), typeof get("lost"));`);
    expect(next.error).toBeUndefined();
    expect(next.output).toBe("yes undefined");
  }, 30_000);

  it("runaway allocation ends the sandbox process, not this one", async () => {
    const sb = new RLMSandbox({ context: "c", timeout: 20_000, onLLMQuery: async () => "x" });
    sandboxes.push(sb);
    await sb.execute(`store("kept", "yes");`);
    const result = await sb.execute(
      `const a = []; for (;;) a.push(new Array(1e6).fill(a.length));`,
    );
    expect(result.error).toMatch(/ended during the run|timed out/);
    expect((await sb.execute(`print(get("kept"));`)).output).toBe("yes");
  }, 60_000);

  it("rejections and finalizer errors in sandbox code never reach this process", async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown) => seen.push(reason);
    const onException = (err: unknown) => seen.push(err);
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
    try {
      const sb = sandbox();
      const result = await sb.execute(
        `Promise.reject(new Error("bye gateway")); Promise.reject("plain"); print("ok");`,
      );
      expect(result.output).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await sb.execute(`print("alive");`)).output).toBe("alive");
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    }
    expect(seen).toEqual([]);
  });

  it("bridged calls are only served while a run is in flight", async () => {
    let calls = 0;
    const sb = new RLMSandbox({
      context: "c",
      timeout: 3000,
      onLLMQuery: async () => {
        calls++;
        return "r";
      },
    });
    sandboxes.push(sb);
    await sb.execute(
      `(async () => { await null; await null; for (let i = 0; i < 50; i++) { try { await llm_query("bg"); } catch (e) {} } })();`,
    );
    const atReturn = calls;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls - atReturn).toBeLessThanOrEqual(1);
  });

  it("caps bridged calls per code block", async () => {
    let calls = 0;
    const sb = new RLMSandbox({
      context: "c",
      timeout: 5000,
      onLLMQuery: async () => {
        calls++;
        return "r";
      },
    });
    sandboxes.push(sb);
    const result = await sb.execute(`
      let refused = 0;
      const jobs = [];
      for (let i = 0; i < 600; i++) jobs.push(llm_query("x").catch(() => { refused++; }));
      await Promise.all(jobs);
      print(refused);
    `);
    expect(result.output).toBe("100");
    expect(calls).toBe(500);
  });

  it("refuses to run after dispose and does not respawn", async () => {
    const sb = sandbox();
    await sb.execute(`print("x");`);
    sb.dispose();
    expect((await sb.execute(`print("y");`)).error).toMatch(/disposed/);
  });
});

describe("RLM sandbox: behaviour kept by the hardening", () => {
  it("reports thrown errors and rejected awaits as data", async () => {
    const sb = sandbox();
    expect((await sb.execute(`throw new Error("boom");`)).error).toBe("boom");
    expect((await sb.execute(`null.x;`)).error).toMatch(/^TypeError: /);
    expect((await sb.execute(`await Promise.reject("plain");`)).error).toBe("plain");
    expect((await sb.execute(`const x = ;`)).error).toBeDefined();
    expect((await sb.execute(`print("ok");`)).output).toBe("ok");
  });

  it("times out a synchronous infinite loop and stays usable", async () => {
    const sb = new RLMSandbox({ context: "c", timeout: 200, onLLMQuery: async () => "x" });
    sandboxes.push(sb);
    const result = await sb.execute(`while (true) {}`);
    expect(result.error).toMatch(/timed out/i);
    expect((await sb.execute(`print("alive");`)).output).toBe("alive");
  });

  it("llm_query_parallel and sub-context round-trip as strings", async () => {
    const seen: Array<string | undefined> = [];
    const sb = new RLMSandbox({
      context: "c",
      timeout: 3000,
      onLLMQuery: async (prompt, sub) => {
        seen.push(sub);
        return `r:${prompt}`;
      },
    });
    sandboxes.push(sb);
    const result = await sb.execute(`
      const a = await llm_query("one", "ctx-one");
      const b = await llm_query_parallel([{ prompt: "two", context: "ctx-two" }, { prompt: "three" }]);
      print(a, b.join("|"), Array.isArray(b));
    `);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("r:one r:two|r:three true");
    expect(seen).toEqual(["ctx-one", "ctx-two", undefined]);
  });

  it("store keeps object identity inside the realm across code blocks", async () => {
    const sb = sandbox();
    await sb.execute(`const list = []; store("list", list); list.push("later");`);
    const result = await sb.execute(`get("list").push("again"); print(get("list").join(","));`);
    expect(result.output).toBe("later,again");
    expect(sb.exportStore().list).toEqual(["later", "again"]);
  });
});

describe("deep_recall is owner-only", () => {
  it("is filtered out of a non-owner sender's tools", () => {
    expect(isOwnerOnlyToolName("deep_recall")).toBe(true);
    const tools = [
      { name: "deep_recall", execute: async () => ({}) },
      { name: "recall_range", execute: async () => ({}) },
    ] as unknown as Parameters<typeof applyOwnerOnlyToolPolicy>[0];
    expect(applyOwnerOnlyToolPolicy(tools, false).map((t) => t.name)).toEqual(["recall_range"]);
    expect(applyOwnerOnlyToolPolicy(tools, true).map((t) => t.name)).toEqual([
      "deep_recall",
      "recall_range",
    ]);
  });
});
