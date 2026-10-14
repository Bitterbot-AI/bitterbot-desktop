import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSetupPath, setupBasePath, takeSetupToken } from "../../lib/setup-route";
import { SetupStepView } from "./SetupStepView";
import { SetupWizard } from "./SetupWizard";

type Handler = (method: string, params: unknown) => unknown;

function fakeLocation(href: string): Location {
  const url = new URL(href);
  return {
    href: url.href,
    pathname: url.pathname,
    protocol: url.protocol,
    host: url.host,
    origin: url.origin,
    search: url.search,
    hash: url.hash,
  } as Location;
}

function makeClientFactory(handler: Handler) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const created: Array<Record<string, unknown>> = [];
  const factory = (opts: Record<string, unknown>) => {
    created.push(opts);
    return {
      start: () => {
        queueMicrotask(() => (opts.onHello as (h: unknown) => void)?.({ type: "hello-ok" }));
      },
      stop: vi.fn(),
      request: async <T,>(method: string, params?: unknown) => {
        calls.push({ method, params });
        const result = handler(method, params);
        if (result instanceof Error) {
          throw result;
        }
        return result as T;
      },
    };
  };
  return { factory, calls, created };
}

const section = (id: string, index: number, title: string) => ({ id, index, total: 7, title });

afterEach(() => {
  sessionStorage.clear();
});

describe("setup route helpers", () => {
  it("recognises /setup under any base path", () => {
    expect(isSetupPath("/setup")).toBe(true);
    expect(isSetupPath("/bb/setup/")).toBe(true);
    expect(isSetupPath("/")).toBe(false);
    expect(isSetupPath("/settings")).toBe(false);
    expect(setupBasePath("/bb/setup")).toBe("/bb");
    expect(setupBasePath("/setup")).toBe("");
  });

  it("takes the token out of the address bar and keeps it for this tab only", () => {
    const replaceState = vi.fn();
    const hist = { state: null, replaceState } as unknown as History;
    const token = takeSetupToken(fakeLocation("http://127.0.0.1:19001/setup?token=abc"), hist);
    expect(token).toBe("abc");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/setup");
    // A reload of the same tab (no query any more) still has it.
    expect(takeSetupToken(fakeLocation("http://127.0.0.1:19001/setup"), hist)).toBe("abc");
  });
});

describe("SetupWizard (the /setup page)", () => {
  it("connects with the setup token and renders each step until done", async () => {
    const steps = [
      {
        id: "s1",
        type: "select",
        message: "Which key should your agent use?",
        options: [
          { value: "env:ANTHROPIC_API_KEY", label: "Anthropic: ANTHROPIC_API_KEY ...9f2c" },
          { value: "paste:anthropic", label: "Paste an Anthropic API key" },
        ],
        initialValue: "env:ANTHROPIC_API_KEY",
        section: section("auth", 1, "Model provider key"),
      },
      {
        id: "s2",
        type: "text",
        message: "Anthropic API key",
        sensitive: true,
        section: section("auth", 1, "Model provider key"),
      },
      {
        id: "s3",
        type: "note",
        title: "First reply",
        message: "Hello!",
        data: { kind: "first-turn", ok: true, latencyMs: 1500, reply: "Hello! I can remember." },
      },
      {
        id: "s4",
        type: "note",
        title: "Health check",
        message: "summary",
        data: {
          kind: "doctor",
          worstLevel: "warn",
          findings: [
            { section: "Install", level: "ok", message: "No version drift" },
            { section: "Install", level: "warn", message: "No browser found" },
          ],
        },
      },
      {
        id: "s5",
        type: "note",
        title: "Done",
        message: "Setup is complete.",
        data: {
          kind: "done",
          channelsNext: true,
          restart: true,
          service: { state: "installed", label: "systemd user service" },
        },
      },
    ];
    let i = 0;
    const { factory, calls, created } = makeClientFactory((method) => {
      if (method === "wizard.start") {
        return { sessionId: "sess", done: false, status: "running", step: steps[i++] };
      }
      if (method === "wizard.next") {
        const step = steps[i++];
        return step ? { done: false, status: "running", step } : { done: true, status: "done" };
      }
      return {};
    });

    render(
      <SetupWizard
        createClient={factory as never}
        location={fakeLocation("http://127.0.0.1:19001/bb/setup?token=tok123")}
      />,
    );

    await screen.findByText("Step 1 of 7: Model provider key");
    expect(created[0]).toMatchObject({ setupToken: "tok123", scopes: ["operator.setup"] });
    expect(created[0]?.token).toBeUndefined();

    fireEvent.click(screen.getByLabelText(/Paste an Anthropic API key/));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "wizard.next",
        params: { sessionId: "sess", answer: { stepId: "s1", value: "paste:anthropic" } },
      }),
    );

    const keyInput = (await screen.findByLabelText("Anthropic API key")) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    expect(keyInput.autocomplete).toBe("off");
    fireEvent.change(keyInput, { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByTestId("setup-first-turn")).toBeTruthy();
    expect(screen.getByText("1.5 s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByTestId("setup-doctor")).toBeTruthy();
    expect(screen.getByText(/No browser found/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByRole("button", { name: "Finish" });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await screen.findByTestId("setup-done");
    expect(screen.getByText(/connect a chat app/)).toBeTruthy();
    expect(screen.getByTestId("setup-service").textContent).toContain(
      "runs in the background as a systemd user service",
    );
    expect(screen.getByRole("link", { name: "Open the Control UI" }).getAttribute("href")).toBe(
      "/bb/",
    );
  });

  it("Done says when the background service still runs another install", async () => {
    const done = {
      id: "d1",
      type: "note",
      title: "Done",
      message: "Setup is complete.",
      data: {
        kind: "done",
        service: {
          state: "elsewhere",
          label: "systemd user service",
          runsFrom: "Bitterbot 1.4.0 from ~/bitterbot-desktop (git clone)",
        },
      },
    };
    const { factory } = makeClientFactory((method) => {
      if (method === "wizard.start") {
        return { sessionId: "sess", done: false, status: "running", step: done };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      return {};
    });
    render(
      <SetupWizard
        createClient={factory as never}
        location={fakeLocation("http://127.0.0.1:19001/setup?token=tok123")}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    await screen.findByTestId("setup-done");
    const text = screen.getByTestId("setup-service").textContent ?? "";
    expect(text).toContain("still runs Bitterbot 1.4.0 from ~/bitterbot-desktop (git clone)");
    expect(text).toContain("bitterbot gateway switch");
  });

  it("explains an expired link when there is no admin sign-in to fall back to", async () => {
    const { factory } = makeClientFactory((method) =>
      method === "wizard.start"
        ? new Error("setup link expired; run `bitterbot onboard` for a new one")
        : {},
    );
    render(
      <SetupWizard
        createClient={factory as never}
        resolveAdminToken={async () => null}
        location={fakeLocation("http://127.0.0.1:19001/setup?token=old")}
      />,
    );
    const alert = await screen.findByTestId("setup-error");
    expect(alert.textContent).toContain("bitterbot onboard");
    // The refused link is forgotten: a reload does not try it again.
    expect(sessionStorage.getItem("bitterbot-setup-token")).toBeNull();
  });

  it("falls back to the admin sign-in when the tab's stored link is refused", async () => {
    sessionStorage.setItem("bitterbot-setup-token", "spent");
    const { factory, created } = makeClientFactory((method, _params) => {
      if (method === "wizard.start" && created.length === 1) {
        return new Error(
          "setup already completed; sign in to the Control UI (admin) to run it again",
        );
      }
      return { sessionId: "admin-sess", done: true, status: "done" };
    });
    render(
      <SetupWizard
        createClient={factory as never}
        resolveAdminToken={async () => "admin-token"}
        location={fakeLocation("http://127.0.0.1:19001/setup")}
      />,
    );
    await waitFor(() => expect(created).toHaveLength(2));
    expect(created[0]).toMatchObject({ setupToken: "spent" });
    expect(created[1]).toMatchObject({ token: "admin-token" });
    expect(created[1]?.setupToken).toBeUndefined();
    expect(sessionStorage.getItem("bitterbot-setup-token")).toBeNull();
    await screen.findByTestId("setup-done");
  });

  it("starts setup again when the gateway restarted and lost the session", async () => {
    const step = {
      id: "s1",
      type: "text",
      message: "Anthropic API key",
      sensitive: true,
      section: section("auth", 1, "Model provider key"),
    };
    let starts = 0;
    const { factory, calls } = makeClientFactory((method) => {
      if (method === "wizard.start") {
        starts += 1;
        return { sessionId: `sess${starts}`, done: false, status: "running", step };
      }
      if (method === "wizard.next") {
        return new Error("wizard not found");
      }
      return {};
    });
    render(
      <SetupWizard
        createClient={factory as never}
        location={fakeLocation("http://127.0.0.1:19001/setup?token=tok")}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Anthropic API key"), {
      target: { value: "sk-ant-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Bitterbot restarted, so setup started again/)).toBeTruthy();
    expect(screen.queryByText("wizard not found")).toBeNull();
    expect(calls.filter((c) => c.method === "wizard.start")).toHaveLength(2);
    expect(screen.getByLabelText("Anthropic API key")).toBeTruthy();
  });

  it("without a setup link, signs in as admin (re-running setup)", async () => {
    const { factory, created } = makeClientFactory(() => ({
      sessionId: "s",
      done: true,
      status: "done",
    }));
    await act(async () => {
      render(
        <SetupWizard
          createClient={factory as never}
          resolveAdminToken={async () => "admin-token"}
          location={fakeLocation("http://127.0.0.1:19001/setup")}
        />,
      );
    });
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ token: "admin-token" });
    expect(created[0]?.setupToken).toBeUndefined();
  });
});

describe("SetupStepView renders any step type", () => {
  it("confirm answers true or false", () => {
    const onAnswer = vi.fn();
    render(
      <SetupStepView
        step={{ id: "c", type: "confirm", message: "Join?" }}
        busy={false}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it("a failed first reply shows the provider error with its options", () => {
    render(
      <SetupStepView
        step={{
          id: "f",
          type: "select",
          message: "The test turn failed",
          options: [
            { value: "retry", label: "Retry" },
            { value: "back", label: "Back" },
            { value: "skip", label: "Skip" },
          ],
          initialValue: "retry",
          data: { kind: "first-turn", ok: false, error: "401 invalid x-api-key" },
        }}
        busy={false}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByTestId("setup-first-turn-error").textContent).toContain("401");
    expect(screen.getByLabelText(/Back/)).toBeTruthy();
  });
});
