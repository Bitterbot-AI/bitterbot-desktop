import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelsStore } from "../../stores/models-store";
import { ModelsView } from "./ModelsView";

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
    { getState: () => ({ request: requestMock }) },
  ),
}));

const catalog = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  { id: "gpt-5.3", name: "GPT-5.3", provider: "openai" },
];

const providers = [
  {
    provider: "anthropic",
    profiles: [
      {
        profileId: "anthropic:default",
        type: "api_key",
        inCooldown: true,
      },
    ],
    envPresent: true,
    envSource: "env: ANTHROPIC_API_KEY",
    configKeyPresent: false,
    winningSource: "profile:anthropic:default",
  },
  {
    provider: "openai",
    profiles: [],
    envPresent: false,
    configKeyPresent: false,
    winningSource: null,
  },
];

function primeResponses() {
  requestMock.mockImplementation((method: string) => {
    if (method === "models.list") return Promise.resolve({ models: catalog });
    if (method === "models.auth.list") return Promise.resolve({ providers });
    if (method === "sessions.list")
      return Promise.resolve({
        sessions: [],
        defaults: { model: "claude-opus-4-8", modelProvider: "anthropic" },
      });
    if (method === "models.setDefault")
      return Promise.resolve({ ok: true, model: "openai/gpt-5.3" });
    if (method === "models.auth.test")
      return Promise.resolve({ result: { ok: true, status: 200 } });
    if (method === "models.auth.set")
      return Promise.resolve({ ok: true, profileId: "openai:default" });
    if (method === "models.auth.delete") return Promise.resolve({ ok: true });
    return Promise.resolve({ ok: true });
  });
}

describe("ModelsView", () => {
  beforeEach(() => {
    requestMock.mockReset();
    helloMethods = ["models.list", "models.auth.list", "models.setDefault", "sessions.list"];
    useModelsStore.setState({
      catalog: [],
      catalogLoaded: false,
      catalogLoading: false,
      sessionModels: {},
      authStatus: [],
      authLoading: false,
      defaultModel: null,
    });
    primeResponses();
  });

  it("renders provider rows with provenance and cooldown state", async () => {
    render(<ModelsView />);
    await waitFor(() => {
      expect(screen.getByText("anthropic")).toBeTruthy();
      expect(screen.getByText("openai")).toBeTruthy();
    });
    expect(screen.getByText("profile:anthropic:default")).toBeTruthy();
    expect(screen.getByText("cooldown")).toBeTruthy();
    expect(screen.getByText("no key")).toBeTruthy();
    // Shadowing warning: the profile wins while an env var is also set.
    expect(screen.getByText(/shadowing env: ANTHROPIC_API_KEY/)).toBeTruthy();
  });

  it("shows the node default model and updates it via models.setDefault", async () => {
    const user = userEvent.setup();
    render(<ModelsView />);
    await waitFor(() => expect(screen.getByText("anthropic/claude-opus-4-8")).toBeTruthy());

    await user.click(screen.getByText("anthropic/claude-opus-4-8"));
    await waitFor(() => expect(screen.getByText("GPT-5.3")).toBeTruthy());
    await user.click(screen.getByText("GPT-5.3"));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("models.setDefault", { model: "openai/gpt-5.3" });
    });
  });

  it("opens the key modal from a provider row and saves via models.auth.set", async () => {
    const user = userEvent.setup();
    render(<ModelsView />);
    await waitFor(() => expect(screen.getByText("openai")).toBeTruthy());

    // Two "Add key" buttons exist (page header + the openai row); the row
    // one pre-fills the provider so the modal has no provider field.
    const addButtons = screen.getAllByRole("button", { name: /Add key/i });
    await user.click(addButtons[addButtons.length - 1]);
    const input = await screen.findByLabelText(/API key/i);
    await user.type(input, "sk-fresh-key");

    await user.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "models.auth.test",
        expect.objectContaining({ apiKey: "sk-fresh-key" }),
      );
      expect(screen.getByText(/Key verified/)).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "models.auth.set",
        expect.objectContaining({ value: "sk-fresh-key", credentialType: "api_key" }),
      );
      // Save triggers a catalog refresh so new providers appear immediately.
      expect(requestMock).toHaveBeenCalledWith("models.list", { refresh: true });
    });
  });

  it("hides key management when the gateway lacks models.auth.*", async () => {
    helloMethods = ["models.list", "sessions.list"];
    render(<ModelsView />);
    await waitFor(() => {
      expect(screen.getByText(/does not support key management/)).toBeTruthy();
    });
    expect(requestMock).not.toHaveBeenCalledWith("models.auth.list", {});
  });
});
