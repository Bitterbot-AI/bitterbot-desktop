import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SoapboxJob } from "../../../../../src/infra/soapbox-client";
import { PaymentPanel } from "./PaymentPanel";
import { WorkerPanel } from "./WorkerPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("counts down the earlier job deadline, removes funding on expiry, and only requests a fresh quote explicitly", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  const job = {
    id: "expired",
    status: "awaiting_payment",
    attempts: 0,
    deadline: 1002,
    payment: { expires: 4600, amount_microusdc: 2000, operator: "operator" },
  } as SoapboxJob;
  const fund = vi.fn(),
    replaceQuote = vi.fn();
  render(<PaymentPanel job={job} busy={false} fund={fund} replaceQuote={replaceQuote} />);
  expect(screen.getByRole("timer").textContent).toBe("Fund within 0:02");
  expect(screen.getByRole("button", { name: "Fund 0.002000 test USDC" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByRole("button", { name: "Fund 0.002000 test USDC" })).toBeNull();
  expect(replaceQuote).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Request fresh quote" }));
  expect(replaceQuote).toHaveBeenCalledOnce();
  expect(fund).not.toHaveBeenCalled();
});
it("does not offer another charge during refund or settlement", () => {
  for (const status of ["refund_pending", "settlement_pending", "payment_review", "succeeded"]) {
    const view = render(
      <PaymentPanel
        job={{ status, attempts: 0, deadline: 1, payment: { expires: 2 } } as SoapboxJob}
        busy={false}
        fund={vi.fn()}
        replaceQuote={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    view.unmount();
  }
});
it("distinguishes startup checks from a manual pause", () => {
  const node = {
    id: "worker",
    online: true,
    operator_paused: false,
    offer: {
      paused: true,
      cpu_threads: 1,
      memory_mib: 2048,
      gpu_observed: false,
      modes: ["private"],
      gpu_unavailable_reason: "Checking sandbox and runtime readiness",
    },
  };
  const snapshot = {
    enabled: true,
    principal: { id: "admin", roles: ["admin"], pools: [], projects: [] },
    nodes: [node],
  };
  const view = render(<WorkerPanel snapshot={snapshot} busy={false} pause={vi.fn()} />);
  expect(screen.getByText("Online · Checking readiness")).toBeTruthy();
  expect(screen.queryByText(/Paused by operator/)).toBeNull();
  view.rerender(
    <WorkerPanel
      snapshot={{ ...snapshot, nodes: [{ ...node, operator_paused: true }] }}
      busy={false}
      pause={vi.fn()}
    />,
  );
  expect(screen.getByText("Online · Paused by operator")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resume new work" })).toBeTruthy();
});
