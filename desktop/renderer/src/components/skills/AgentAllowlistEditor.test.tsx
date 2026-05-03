import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAllowlistEditor } from "./AgentAllowlistEditor";

const requestMock = vi.fn();

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({
      request: requestMock,
      status: "connected",
      subscribe: () => () => {},
    }),
}));

const skills = [
  {
    key: "shell",
    name: "shell",
    description: "Run shell commands",
    enabled: true,
    installed: true,
    hasApiKey: false,
    state: "ready" as const,
    reasons: [],
  },
  {
    key: "web-fetch",
    name: "web-fetch",
    description: "Fetch URLs",
    enabled: true,
    installed: true,
    hasApiKey: false,
    state: "ready" as const,
    reasons: [],
  },
];

describe("AgentAllowlistEditor", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("hydrates from config.get and shows existing allowlist", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: {
            agents: { list: [{ id: "main", skills: ["shell"] }] },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    render(
      <AgentAllowlistEditor
        agentId="main"
        agentLabel="main"
        allSkills={skills}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    // Mode pill should switch to Custom allowlist after hydration.
    await waitFor(() => {
      expect(screen.getByText(/1 selected/i)).toBeTruthy();
    });
  });

  it("save with mode=all sends skills:null", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({ config: { agents: { list: [{ id: "main" }] } } });
      }
      return Promise.resolve({ ok: true });
    });
    const onSaved = vi.fn();
    render(
      <AgentAllowlistEditor
        agentId="main"
        agentLabel="main"
        allSkills={skills}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    await waitFor(() => screen.getByText(/All installed skills are available/i));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("skills.updateAgentFilter", {
        agentId: "main",
        skills: null,
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("save with custom allowlist sends only checked skills", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: { agents: { list: [{ id: "main", skills: ["shell"] }] } },
        });
      }
      return Promise.resolve({ ok: true });
    });
    render(
      <AgentAllowlistEditor
        agentId="main"
        agentLabel="main"
        allSkills={skills}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    // Wait until hydration completes (the "1 selected" line tells us we're in
    // Custom allowlist mode with the loaded list).
    await waitFor(() => screen.getByText(/1 selected/i));

    const user = userEvent.setup();
    // Click the Select all button to add web-fetch.
    await user.click(screen.getByRole("button", { name: /select all/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) => c[0] === "skills.updateAgentFilter");
      expect(call).toBeTruthy();
      expect(call?.[1]).toEqual({
        agentId: "main",
        skills: expect.arrayContaining(["shell", "web-fetch"]),
      });
    });
  });
});
