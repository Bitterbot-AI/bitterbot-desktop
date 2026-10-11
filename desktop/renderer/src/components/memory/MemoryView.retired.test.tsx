/**
 * PLAN-55 Phase 0: the Memory page lists retired facts and lets the owner
 * bring one back through memory.unretireFact.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryView } from "./MemoryView";

const requestMock = vi.fn();

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));

const active = {
  key: "infra.deploy_endpoint",
  value: "api2.acme.com",
  statement: "The deploy endpoint is api2.acme.com.",
  category: "infra",
  source: "owner",
  status: "active",
};
const ownerRetired = {
  key: "identity.user.name",
  value: "Victor",
  statement: "The user's name is Victor.",
  category: "identity",
  source: "agent_pin",
  status: "owner_retired",
};
const faded = {
  key: "project.repo",
  value: "github.com/x/y",
  statement: "project.repo: github.com/x/y",
  category: "project",
  source: "extraction",
  status: "retired",
};

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "memory.list":
        return { memories: [], nextCursor: null };
      case "memory.facts":
        return params?.status === "retired"
          ? { facts: [ownerRetired, faded] }
          : { facts: [active] };
      case "memory.preferences":
        return { preferences: [] };
      case "memory.audit":
        return { entries: [] };
      case "memory.unretireFact":
        return { ok: true };
      case "memory.retireFact":
        return { ok: true };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
});

describe("MemoryView retired facts (PLAN-55 Phase 0)", () => {
  it("lists retired facts apart from settled ones, marking the owner's own", async () => {
    render(<MemoryView />);
    await screen.findByText("Retired facts");
    expect(screen.getByText("The deploy endpoint is api2.acme.com.")).toBeTruthy();
    expect(screen.getByText(/The user's name is Victor\.\s*\(retired by you\)/)).toBeTruthy();
    expect(screen.getByText("project.repo: github.com/x/y")).toBeTruthy();
    expect(requestMock).toHaveBeenCalledWith("memory.facts", { status: "retired" });
    // The copy no longer promises that saying it again brings it back.
    expect(screen.queryByText(/come back if you say it again/)).toBeNull();
  });

  it("Bring back calls memory.unretireFact and moves the fact to the settled list", async () => {
    render(<MemoryView />);
    await screen.findByText("Retired facts");
    const [bringBack] = screen.getAllByText("Bring back");
    await userEvent.setup().click(bringBack!);
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.unretireFact", {
        key: "identity.user.name",
      }),
    );
    await waitFor(() => expect(screen.getAllByText("Retire")).toHaveLength(2));
    expect(screen.queryByText(/\(retired by you\)/)).toBeNull();
  });

  it("Retire moves a settled fact into the retired list as yours", async () => {
    render(<MemoryView />);
    await screen.findByText("Settled facts");
    await userEvent.setup().click(screen.getByText("Retire"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.retireFact", {
        key: "infra.deploy_endpoint",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/The deploy endpoint is api2.acme.com\.\s*\(retired by you\)/),
      ).toBeTruthy(),
    );
  });
});
