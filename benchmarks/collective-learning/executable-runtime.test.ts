import { afterEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ calls: [] as string[][], mode: "pass" }));
vi.mock("node:child_process", () => {
  const execFile = (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    fake.calls.push(args);
    if (args[0] === "inspect") {
      if (fake.mode === "mismatch")
        callback(
          null,
          JSON.stringify([
            {
              Name: "/" + args[1],
              Image: "wrong-image",
              Config: { Labels: { "bitterbot.executable-study": "1" } },
            },
          ]),
          "",
        );
      else callback(Object.assign(new Error("removed"), { code: 1 }), "", "");
    } else if (fake.mode === "timeout")
      callback(Object.assign(new Error("timeout"), { code: "ETIMEDOUT", killed: true }), "", "");
    else if (fake.mode === "nonzero")
      callback(Object.assign(new Error("exit"), { code: 2 }), "", "invalid input");
    else callback(null, "ok", "");
  };
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, args: string[], options: unknown) =>
      new Promise((resolve, reject) =>
        execFile(file, args, options, (error, stdout, stderr) =>
          error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
        ),
      ),
  });
  return { execFile };
});
import { dockerPython } from "./executable-runtime.js";
afterEach(() => {
  fake.calls.length = 0;
  fake.mode = "pass";
});
describe("executable workflow sandbox boundary", () => {
  it("invokes exact Python argv with read-only inputs, no network and no checker mount", async () => {
    const result = await dockerPython(
      "sha256:pinned",
      [
        { source: "/study/package", target: "/skill" },
        { source: "/study/input", target: "/inputs" },
        { source: "/study/output", target: "/output", write: true },
      ],
      ["/skill/helper.py", "--data", "/inputs/data.json"],
    );
    expect(result.exitCode).toBe(0);
    const args = fake.calls[0];
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("type=bind,src=/study/package,dst=/skill,readonly");
    expect(args).toContain("type=bind,src=/study/output,dst=/output");
    expect(args.some((a) => a.includes("checker"))).toBe(false);
    expect(args.slice(-7)).toEqual([
      "sha256:pinned",
      "-I",
      "-X",
      "utf8",
      "/skill/helper.py",
      "--data",
      "/inputs/data.json",
    ]);
  });
  it("rejects mount argument injection before dispatch", async () => {
    await expect(
      dockerPython("pinned", [{ source: "/tmp/evil,readonly=false", target: "/skill" }], []),
    ).rejects.toThrow("Invalid mount");
    expect(fake.calls).toHaveLength(0);
  });
  it("keeps a verified nonzero exit separate from infrastructure failure", async () => {
    fake.mode = "nonzero";
    expect((await dockerPython("pinned", [], [])).exitCode).toBe(2);
  });
  it("does not classify an unobserved timeout as task failure", async () => {
    fake.mode = "timeout";
    await expect(dockerPython("pinned", [], [])).rejects.toThrow("Unresolved local sandbox");
  });
  it("never removes a container with mismatched identity", async () => {
    fake.mode = "mismatch";
    await expect(dockerPython("pinned", [], [])).rejects.toThrow("identity mismatch");
    expect(fake.calls.some((a) => a[0] === "rm")).toBe(false);
  });
});
