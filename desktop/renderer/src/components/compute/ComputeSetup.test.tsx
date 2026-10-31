import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SoapboxSetupStatus } from "../../../../../src/infra/soapbox-setup-types";
import { ComputeSetup } from "./ComputeSetup";

const fake = vi.hoisted(() => ({ request: vi.fn(), status: "connected" }));
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (s: typeof fake) => unknown) => selector(fake),
}));
let status: SoapboxSetupStatus;
beforeEach(() => {
  status = {
    configured: false,
    platformSupported: true,
    hasWalletCredentials: false,
    walletAddress: null,
    release: {
      url: "https://github.com/Bitterbot-AI/soapbox/releases/tag/v0.3.0-rc.1",
      filename: "runtime.tar.gz",
      bytes: 4,
    },
    progress: { state: "idle", message: "", percent: 0 },
  };
  fake.request.mockImplementation(async (method: string) => {
    if (method === "soapbox.setup.wallet")
      status = { ...status, walletAddress: `0x${"1".repeat(40)}` };
    return status;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("enables a local operator in one action without enrollment or wallet calls", async () => {
  status.bundledRuntimeAvailable = true;
  render(<ComputeSetup onClose={() => {}} />);
  fireEvent.click(await screen.findByLabelText("GPU operator · share this device"));
  expect(screen.queryByLabelText("Enrollment file")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Enable this GPU operator" }));
  await waitFor(() => expect(fake.request).toHaveBeenCalledWith("soapbox.setup.operator.enable"));
  expect(fake.request.mock.calls.some(([method]) => /wallet|payment|import/.test(method))).toBe(
    false,
  );
});
it("creates a separate buyer wallet and clears entered secrets", async () => {
  render(<ComputeSetup onClose={() => {}} />);
  fireEvent.change(await screen.findByLabelText("CDP API key ID"), { target: { value: "key" } });
  fireEvent.change(screen.getByLabelText("CDP API key secret"), { target: { value: "secret" } });
  fireEvent.change(screen.getByLabelText("CDP wallet secret"), {
    target: { value: "wallet-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create test wallet" }));
  await screen.findByLabelText("Test wallet address");
  expect(fake.request).toHaveBeenCalledWith(
    "soapbox.setup.wallet",
    { credentials: { apiKeyId: "key", apiKeySecret: "secret", walletSecret: "wallet-secret" } },
    { timeoutMs: 120000 },
  );
  expect(screen.queryByDisplayValue("wallet-secret")).toBeNull();
  expect(
    fake.request.mock.calls.some(
      ([method]) => method === "wallet.setConfig" || method === "soapbox.payment.fund",
    ),
  ).toBe(false);
});
it("requires verified runtime and explicit consent before activating an operator", async () => {
  status = {
    ...status,
    enrollment: {
      role: "operator",
      id: "gpu-test",
      url: "https://compute.example",
      address: `0x${"2".repeat(40)}`,
      chain_id: 84532,
    },
    progress: { state: "preparing", message: "Verifying GPU execution and isolation", percent: 85 },
  };
  const rendered = render(<ComputeSetup onClose={() => {}} />);
  const activate = await screen.findByRole("button", { name: "Activate operator" });
  expect((activate as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Create test wallet" })).toBeNull();
  expect(screen.getByText("Verifying GPU execution and isolation")).toBeTruthy();
  rendered.unmount();
  status = {
    ...status,
    progress: { state: "ready", message: "GPU runtime verified", percent: 100 },
  };
  render(<ComputeSetup onClose={() => {}} />);
  const ready = await screen.findByRole("button", { name: "Activate operator" });
  expect((ready as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(ready);
  await waitFor(() => expect(fake.request).toHaveBeenCalledWith("soapbox.setup.activate"));
});
it("keeps configured gateways read only and explains where the tester runs setup", async () => {
  status.configured = true;
  status.configuredRole = "pilot";
  render(<ComputeSetup onClose={() => {}} />);
  await screen.findByText(/Compute is configured on this gateway/);
  expect(screen.queryByLabelText("Enrollment file")).toBeNull();
  expect(screen.getByText(/tester’s own Bitterbot app/)).toBeTruthy();
});

it("offers explicit saved-profile switching without funding or creating wallets", async () => {
  status.configured = true;
  status.configuredRole = "mesh-operator";
  status.canManageProfiles = true;
  status.profiles = [
    { id: "operator", role: "mesh-operator", name: "Local P2P operator", active: true },
    { id: "buyer", role: "buyer", name: "Buyer · tester", active: false },
  ];
  render(<ComputeSetup onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Switch to Buyer · tester" }));
  await waitFor(() =>
    expect(fake.request).toHaveBeenCalledWith("soapbox.setup.profile.switch", { id: "buyer" }),
  );
  expect(fake.request.mock.calls.some(([method]) => /wallet|payment/.test(method))).toBe(false);
});

it("clears a transient status error after the gateway reconnects", async () => {
  fake.request.mockRejectedValueOnce(new Error("Gateway restarting"));
  render(<ComputeSetup onClose={() => {}} />);
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), { timeout: 4000 });
  expect(screen.getByRole("button", { name: "Create test wallet" })).toBeTruthy();
});

it("prepares the bundled runtime without asking the operator to download another archive", async () => {
  status.bundledRuntimeAvailable = true;
  status.enrollment = {
    role: "operator",
    id: "gpu-test",
    url: "https://compute.example",
    address: `0x${"2".repeat(40)}`,
    chain_id: 84532,
  };
  render(<ComputeSetup onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Prepare GPU runtime" }));
  await waitFor(() => expect(fake.request).toHaveBeenCalledWith("soapbox.setup.runtime.bundled"));
  expect(screen.queryByLabelText("GPU runtime archive")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Activate operator" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
