import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../stores/chat-store";
import { useModelsStore } from "../../stores/models-store";
import { ModelPicker } from "./ModelPicker";

const requestMock = vi.fn();

let helloMethods: string[] | undefined;

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        request: requestMock,
        status: "connected",
        hello: { features: { methods: helloMethods } },
      }),
    {
      getState: () => ({ request: requestMock }),
    },
  ),
}));

const catalog = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", reasoning: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  { id: "gpt-5.3", name: "GPT-5.3", provider: "openai" },
];

function primeGatewayResponses(overrides?: {
  patchResult?: unknown;
  listRow?: Record<string, unknown>;
}) {
  requestMock.mockImplementation((method: string) => {
    if (method === "models.list") return Promise.resolve({ models: catalog });
    if (method === "sessions.resolve") return Promise.resolve({ ok: true, key: "agent:main:main" });
    if (method === "sessions.list")
      return Promise.resolve({
        sessions: [
          overrides?.listRow ?? {
            key: "agent:main:main",
            model: "claude-opus-4-8",
            modelProvider: "anthropic",
            modelOverridden: false,
          },
        ],
        defaults: { model: "claude-opus-4-8", modelProvider: "anthropic" },
      });
    if (method === "sessions.patch")
      return Promise.resolve(
        overrides?.patchResult ?? {
          ok: true,
          entry: { modelOverride: "gpt-5.3", providerOverride: "openai" },
          resolved: { model: "gpt-5.3", modelProvider: "openai" },
        },
      );
    return Promise.resolve({ ok: true });
  });
}

describe("ModelPicker", () => {
  beforeEach(() => {
    requestMock.mockReset();
    helloMethods = ["models.list", "sessions.patch", "sessions.list", "sessions.resolve"];
    useChatStore.setState({ sessionKey: "default" });
    useModelsStore.setState({
      catalog: [],
      catalogLoaded: false,
      catalogLoading: false,
      sessionModels: {},
    });
    primeGatewayResponses();
  });

  it("shows the session's effective model in the trigger pill", async () => {
    render(<ModelPicker />);
    await waitFor(() => {
      expect(screen.getByText("claude-opus-4-8")).toBeTruthy();
    });
  });

  it("opens the catalog grouped by provider and patches the session on select", async () => {
    const user = userEvent.setup();
    render(<ModelPicker />);
    await waitFor(() => expect(screen.getByText("claude-opus-4-8")).toBeTruthy());

    await user.click(screen.getByText("claude-opus-4-8"));
    await waitFor(() => expect(screen.getByText("GPT-5.3")).toBeTruthy());
    expect(screen.getByText("anthropic")).toBeTruthy();
    expect(screen.getByText("openai")).toBeTruthy();

    await user.click(screen.getByText("GPT-5.3"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("sessions.patch", {
        key: "default",
        model: "openai/gpt-5.3",
      });
    });
    // Pill reflects the server-reported resolved model, not a client guess.
    await waitFor(() => expect(screen.getByText("gpt-5.3")).toBeTruthy());
  });

  it("offers reset-to-default only when the session is overridden, and sends model:null", async () => {
    primeGatewayResponses({
      listRow: {
        key: "agent:main:main",
        model: "gpt-5.3",
        modelProvider: "openai",
        modelOverridden: true,
      },
      patchResult: {
        ok: true,
        entry: {},
        resolved: { model: "claude-opus-4-8", modelProvider: "anthropic" },
      },
    });
    const user = userEvent.setup();
    render(<ModelPicker />);
    await waitFor(() => expect(screen.getByText("gpt-5.3")).toBeTruthy());

    await user.click(screen.getByText("gpt-5.3"));
    const reset = await screen.findByText("Reset to default");
    await user.click(reset);
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("sessions.patch", { key: "default", model: null });
    });
    await waitFor(() => expect(screen.getByText("claude-opus-4-8")).toBeTruthy());
  });

  it("renders nothing when the gateway does not advertise the required methods", () => {
    helloMethods = ["sessions.list"];
    const { container } = render(<ModelPicker />);
    expect(container.innerHTML).toBe("");
  });

  it("re-reads the server state when the patch fails", async () => {
    const user = userEvent.setup();
    render(<ModelPicker />);
    await waitFor(() => expect(screen.getByText("claude-opus-4-8")).toBeTruthy());

    requestMock.mockImplementation((method: string) => {
      if (method === "sessions.patch") return Promise.reject(new Error("model not allowed"));
      if (method === "models.list") return Promise.resolve({ models: catalog });
      if (method === "sessions.resolve")
        return Promise.resolve({ ok: true, key: "agent:main:main" });
      if (method === "sessions.list")
        return Promise.resolve({
          sessions: [
            {
              key: "agent:main:main",
              model: "claude-opus-4-8",
              modelProvider: "anthropic",
              modelOverridden: false,
            },
          ],
        });
      return Promise.resolve({ ok: true });
    });

    await user.click(screen.getByText("claude-opus-4-8"));
    await waitFor(() => expect(screen.getByText("GPT-5.3")).toBeTruthy());
    await user.click(screen.getByText("GPT-5.3"));

    // Pill must fall back to the server truth (still opus), never the failed pick.
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("sessions.list", {});
      expect(screen.getByText("claude-opus-4-8")).toBeTruthy();
    });
  });
});
