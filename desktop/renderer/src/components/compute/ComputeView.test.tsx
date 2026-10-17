import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputeView } from "./ComputeView";

const fake = vi.hoisted(() => ({ request: vi.fn(), status: "connected" }));
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (s: typeof fake) => unknown) => selector(fake),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("Compute view", () => {
  it("shows operator earnings and own pause control without a buyer wallet", async () => {
    fake.request.mockResolvedValue({
      enabled: true,
      settlement: "usdc_escrow",
      principal: { id: "test-worker", roles: ["worker"], pools: [], projects: [] },
      payment_account: { chain_id: 84532, address: `0x${"3".repeat(40)}` },
      nodes: [
        {
          id: "test-worker",
          online: true,
          offer: { modes: ["paid"], cpu_threads: 1, memory_mib: 2048, isolation: "docker_v1" },
        },
      ],
      jobs: [
        {
          id: "own-job",
          status: "succeeded",
          attempts: 1,
          spec: { workload: { kind: "embeddings" }, mode: { kind: "paid_usdc" } },
          payment: { amount_microusdc: 2000 },
        },
      ],
    });
    render(<ComputeView />);
    await screen.findByLabelText("Operator account");
    expect(screen.getByText(/Confirmed earnings in recent jobs: 0.002000 test USDC/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit job" })).toBeNull();
    expect(screen.queryByLabelText("Compute test wallet")).toBeNull();
    expect(fake.request.mock.calls.some(([m]) => m === "soapbox.wallet")).toBe(false);
    fireEvent.click(screen.getByText("Pause new work"));
    await waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith("soapbox.worker.pause", {
        id: "test-worker",
        paused: true,
      }),
    );
  });
  it("shows an exact USDC quote and requires a separate funding action", async () => {
    const job = {
      id: "paid-job",
      status: "awaiting_payment",
      payment: {
        amount_microusdc: 2000,
        operator: `0x${"3".repeat(40)}`,
        chain_id: 84532,
      },
    };
    fake.request.mockImplementation(async (method: string) => {
      if (method === "soapbox.submit") return job;
      if (method === "soapbox.payment.fund") return { job: { ...job, status: "queued" } };
      return {
        enabled: true,
        settlement: "usdc_escrow",
        principal: { roles: [], pools: [], projects: [] },
        jobs: [],
        nodes: [
          {
            id: "worker",
            online: true,
            offer: { isolation: "docker_v1", modes: ["paid"], cpu_threads: 1, memory_mib: 2048 },
          },
        ],
      };
    });
    render(<ComputeView />);
    fireEvent.change(await screen.findByLabelText("Participation mode"), {
      target: { value: "paid" },
    });
    expect((screen.getByRole("button", { name: "Submit job" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      Array.from(document.querySelectorAll("input,select,textarea"))
        .filter((element) => !(element as HTMLInputElement).checkValidity())
        .map((element) => ({
          html: element.outerHTML,
          message: (element as HTMLInputElement).validationMessage,
        })),
    ).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Submit job" }));
    const fund = await screen.findByRole("button", { name: "Fund 0.002000 test USDC" });
    expect(fake.request.mock.calls.some(([method]) => method === "soapbox.payment.fund")).toBe(
      false,
    );
    expect(fake.request).toHaveBeenCalledWith(
      "soapbox.submit",
      expect.objectContaining({
        mode: { kind: "paid_usdc", max_cost_microusdc: 10000, operator: "worker" },
      }),
    );
    fireEvent.click(fund);
    await waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith(
        "soapbox.payment.fund",
        { id: "paid-job" },
        { timeoutMs: 600000 },
      ),
    );
  });
  it("explains opt-in setup when the service is disabled", async () => {
    fake.request.mockResolvedValue({ enabled: false });
    render(<ComputeView />);
    expect(await screen.findByText("Get started with Compute")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit job" })).toBeNull();
  });
  it("submits a private job using an authorized pool and displays test-credit limits", async () => {
    const snapshot = {
      enabled: true,
      principal: { id: "buyer", roles: ["submitter"], pools: ["circle-1"], projects: [] },
      nodes: [],
      jobs: [],
    };
    fake.request.mockImplementation(async (method: string) =>
      method === "soapbox.submit" ? { id: "job-1", status: "queued" } : snapshot,
    );
    render(<ComputeView />);
    expect(await screen.findByText(/Paid jobs use non-redeemable test credits/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit job" }));
    await waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith(
        "soapbox.submit",
        expect.objectContaining({
          mode: { kind: "private", pool_id: "circle-1" },
          idempotency_key: expect.any(String),
        }),
      ),
    );
  });
  it("pins GPU submissions to a ready model and displays the hardware", async () => {
    const digest = "a".repeat(64);
    const snapshot = {
      enabled: true,
      principal: { id: "buyer", roles: ["submitter"], pools: ["circle"], projects: [] },
      jobs: [],
      nodes: [
        {
          id: "gpu-worker",
          online: true,
          operator_paused: false,
          offer: {
            cpu_threads: 1,
            memory_mib: 2048,
            gpu_observed: true,
            paused: false,
            modes: ["private"],
            pools: ["circle"],
            projects: [],
            runtime: { model: "all-minilm:latest", model_digest: digest, version: "test" },
            hardware: [
              {
                uuid: "gpu",
                name: "RTX 4080",
                memory_free_mib: 14000,
                memory_total_mib: 16376,
                temperature_c: 50,
                utilization_pct: 3,
              },
            ],
          },
        },
      ],
    };
    fake.request.mockImplementation(async (method: string) =>
      method === "soapbox.submit" ? { id: "gpu-job", status: "succeeded" } : snapshot,
    );
    render(<ComputeView />);
    await screen.findByText(/RTX 4080/);
    fireEvent.change(screen.getByLabelText("Workload"), { target: { value: "embeddings" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit job" }));
    await waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith(
        "soapbox.submit",
        expect.objectContaining({
          workload: expect.objectContaining({
            kind: "embeddings",
            model: "all-minilm:latest",
            model_digest: digest,
          }),
          resources: expect.objectContaining({ require_gpu: true }),
        }),
      ),
    );
  });
  it("does not submit GPU jobs when no eligible model is ready", async () => {
    fake.request.mockResolvedValue({
      enabled: true,
      principal: { pools: ["circle"], projects: [], roles: [] },
      nodes: [],
      jobs: [],
    });
    render(<ComputeView />);
    await screen.findByLabelText("Workload");
    fireEvent.change(screen.getByLabelText("Workload"), { target: { value: "embeddings" } });
    expect((screen.getByRole("button", { name: "Submit job" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("No GPU models ready for this mode")).toBeTruthy();
  });
  it("refreshes the selected result until execution completes", async () => {
    fake.request.mockImplementation(async (method: string) => {
      if (method === "soapbox.submit") return { id: "job-1", status: "queued" };
      if (method === "soapbox.job")
        return { id: "job-1", status: "succeeded", result: { hashes: ["completed-result"] } };
      return {
        enabled: true,
        principal: { pools: ["circle"], projects: [], roles: [] },
        nodes: [],
        jobs: [],
      };
    });
    render(<ComputeView />);
    fireEvent.click(await screen.findByRole("button", { name: "Submit job" }));
    await waitFor(() => expect(screen.getByText(/completed-result/)).toBeTruthy(), {
      timeout: 4000,
    });
  });
});
