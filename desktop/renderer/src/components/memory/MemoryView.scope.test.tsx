/**
 * PLAN-55 Phase 1: a settled fact shows where it applies as a small chip;
 * global facts show none.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeScope, MemoryView } from "./MemoryView";

const requestMock = vi.fn();

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));

const facts = [
  {
    key: "infra.deploy_endpoint",
    value: "api2.acme.com",
    statement: "The deploy endpoint is api2.acme.com.",
    category: "infra",
    source: "owner",
    status: "active",
    scope: "project:acme",
  },
  {
    key: "identity.user.name",
    value: "Victor",
    statement: "The user's name is Victor.",
    category: "identity",
    source: "owner",
    status: "active",
    scope: "global",
  },
  {
    key: "relationship.alice.role",
    value: "designer",
    statement: "Alice is the designer.",
    category: "relationship",
    source: "agent_pin",
    status: "active",
    scope: "person:alice",
  },
];

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "memory.list":
        return { memories: [], nextCursor: null };
      case "memory.facts":
        return params?.status === "retired" ? { facts: [] } : { facts };
      case "memory.preferences":
        return { preferences: [] };
      case "memory.audit":
        return { entries: [] };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
});

describe("describeScope", () => {
  it("words a scope for the chip, none for global", () => {
    expect(describeScope("global")).toBeNull();
    expect(describeScope(undefined)).toBeNull();
    expect(describeScope("project:acme")).toBe("project acme");
    expect(describeScope("person:alice")).toBe("about alice");
  });
});

describe("MemoryView scope chips (PLAN-55 Phase 1)", () => {
  it("shows a chip for project and person scopes and none for global", async () => {
    render(<MemoryView />);
    await screen.findByText("Settled facts");
    expect(screen.getByText("project acme")).toBeTruthy();
    expect(screen.getByText("about alice")).toBeTruthy();
    expect(screen.queryByText(/global/)).toBeNull();
    // The fact text itself is still rendered next to the chip.
    expect(screen.getByText(/The deploy endpoint is api2\.acme\.com\./)).toBeTruthy();
  });
});
