import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; stdin: string }>);
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const entry = { file, args, stdin: "" };
      calls.push(entry);
      setTimeout(() => cb(null, "42\n", ""), 0);
      return { stdin: { end: (data: string) => (entry.stdin = data) } };
    },
  };
});

const { createCodeInterpreterTool } = await import("./code-interpreter-tool.js");

beforeEach(() => {
  calls.length = 0;
});

describe("code_interpreter with a sandbox (PLAN-53 A5)", () => {
  it("runs Python in the agent's container with the code on stdin", async () => {
    const tool = createCodeInterpreterTool({
      sandbox: { containerName: "bb-sbx-1", containerWorkdir: "/workspace" },
    });
    const code = 'print(6 * 7)  # it\'s "quoted"; $(not a shell)';
    const res = await tool.execute("c1", { language: "python", code });

    expect(calls[0]).toEqual({
      file: "docker",
      args: ["exec", "-i", "-w", "/workspace", "bb-sbx-1", "python3", "-"],
      stdin: code,
    });
    expect(res.details).toMatchObject({ ok: true, stdout: "42\n" });
  });

  it("runs Python on the host without a sandbox", async () => {
    await createCodeInterpreterTool().execute("c2", { language: "python", code: "print(1)" });
    expect(calls[0]?.file).not.toBe("docker");
  });
});
