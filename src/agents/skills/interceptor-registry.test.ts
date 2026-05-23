import { describe, expect, it, beforeEach } from "vitest";
import type { PreActionInterceptor } from "./interceptor.js";
import { getInterceptorRegistry } from "./interceptor-registry.js";

function mk(
  id: string,
  skill: string,
  opts: Partial<PreActionInterceptor> = {},
): PreActionInterceptor {
  return {
    id,
    skill,
    priority: 0,
    shouldActivate: () => true,
    intervene: () => ({ type: "noop" }),
    ...opts,
  };
}

describe("interceptor-registry", () => {
  beforeEach(() => getInterceptorRegistry().clear());

  it("register / list returns the entry", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a"));
    expect(reg.list().map((e) => e.interceptor.id)).toEqual(["a:1"]);
  });

  it("unregisterBySkill removes all entries for a skill", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a"));
    reg.register(mk("a:2", "a"));
    reg.register(mk("b:1", "b"));
    expect(reg.unregisterBySkill("a")).toBe(2);
    expect(reg.list().map((e) => e.interceptor.id)).toEqual(["b:1"]);
  });

  it("candidatesFor pre-filters by tool name", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a", { tools: ["t1"] }));
    reg.register(mk("b:1", "b", { tools: ["t2"] }));
    reg.register(mk("c:1", "c")); // matches all
    const r = reg.candidatesFor("t1").map((e) => e.interceptor.id);
    expect(r.sort()).toEqual(["a:1", "c:1"]);
  });

  it("config disabled list excludes by id or skill", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a"));
    reg.register(mk("b:1", "b"));
    reg.register(mk("c:1", "c"));
    reg.setConfigDisabledList(["a:1", "b"]);
    const r = reg.candidatesFor("anything").map((e) => e.interceptor.id);
    expect(r).toEqual(["c:1"]);
  });

  it("markFailure auto-disables at 3 strikes", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a"));
    expect(reg.isDisabled("a:1")).toBe(false);
    reg.markFailure("a:1", 1);
    expect(reg.isDisabled("a:1")).toBe(false);
    reg.markFailure("a:1", 3);
    expect(reg.isDisabled("a:1")).toBe(true);
  });

  it("loadPersistedDisabled applies a cross-session disabled set", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a"));
    reg.loadPersistedDisabled(["a:1"]);
    expect(reg.isDisabled("a:1")).toBe(true);
    expect(reg.candidatesFor("anything").map((e) => e.interceptor.id)).not.toContain("a:1");
  });

  it("enableForOperator clears the in-process disabled flag", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a"));
    reg.markFailure("a:1", 3);
    expect(reg.isDisabled("a:1")).toBe(true);
    reg.enableForOperator("a:1");
    expect(reg.isDisabled("a:1")).toBe(false);
  });

  it("priority ordering: candidatesFor sorts by descending priority", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("lo:1", "lo", { priority: 1 }));
    reg.register(mk("hi:1", "hi", { priority: 9 }));
    reg.register(mk("mid:1", "mid", { priority: 5 }));
    const r = reg.candidatesFor("any").map((e) => e.interceptor.id);
    expect(r).toEqual(["hi:1", "mid:1", "lo:1"]);
  });

  it("recordFire/firesThisEpisode/resetSession", () => {
    const reg = getInterceptorRegistry();
    reg.register(mk("a:1", "a"));
    reg.recordFire("s1", "a:1");
    reg.recordFire("s1", "a:1");
    expect(reg.firesThisEpisode("s1", "a:1")).toBe(2);
    reg.resetSession("s1");
    expect(reg.firesThisEpisode("s1", "a:1")).toBe(0);
  });
});
