import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrustSettings } from "./TrustSettings";

const requestMock = vi.fn();

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({
      request: requestMock,
      status: "connected",
      subscribe: () => () => {},
    }),
}));

describe("TrustSettings", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("hydrates from config.get and renders saved values", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: {
            skills: {
              p2p: {
                ingestPolicy: "review",
                maxIngestedPerHour: 50,
                injectionScanner: "regex",
                quarantineTtlDays: 14,
              },
              agentskills: { enabled: true, defaultTrust: "auto" },
            },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });
    render(<TrustSettings onClose={() => {}} />);
    await waitFor(() => {
      const numberInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
      const values = numberInputs.map((input) => input.value);
      expect(values).toContain("50");
      expect(values).toContain("14");
    });
  });

  it("save calls skills.updateTrustSettings with current values", async () => {
    requestMock.mockImplementation((method: string) => {
      if (method === "config.get") {
        return Promise.resolve({ config: {} });
      }
      return Promise.resolve({ ok: true });
    });
    const onClose = vi.fn();
    render(<TrustSettings onClose={onClose} />);
    await waitFor(() => screen.getByRole("button", { name: /^save$/i }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const call = requestMock.mock.calls.find((c) => c[0] === "skills.updateTrustSettings");
      expect(call).toBeTruthy();
    });
    expect(onClose).toHaveBeenCalled();
  });
});
