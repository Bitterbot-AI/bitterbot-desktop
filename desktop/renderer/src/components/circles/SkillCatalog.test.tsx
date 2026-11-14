import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillCatalog } from "./SkillCatalog";

const request = vi.fn();
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (select: (state: unknown) => unknown) => select({ request }),
}));
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (method: string) => {
    if (method === "skills.packages.list")
      return {
        enabled: true,
        packages: [],
        releases: [],
        ownPackages: [],
        active: [],
        costs: { unknownRuns: 0 },
      };
    return [];
  });
});
afterEach(cleanup);
it("keeps publication, evidence, evaluation and adoption as independent explicit grants", async () => {
  render(
    <SkillCatalog circleId="circle" selfPubkey={`ed25519:${"a".repeat(64)}`} onClose={() => {}} />,
  );
  await screen.findByText("No packages have been shared with this Circle.");
  expect(request.mock.calls.some(([method]) => method === "skills.packages.policy.set")).toBe(
    false,
  );
  fireEvent.click(screen.getByText("Persistent automation grants"));
  fireEvent.change(screen.getByLabelText("Stable skill ID"), { target: { value: "brief" } });
  fireEvent.click(screen.getByLabelText("Evaluate incoming packages"));
  fireEvent.click(screen.getByRole("button", { name: "Save Circle grant" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "skills.packages.policy.set",
      expect.objectContaining({
        policy: expect.objectContaining({
          operations: ["evaluate"],
          categories: ["skill-package"],
          scope: { kind: "circle", circleId: "circle" },
          budget: expect.objectContaining({ providerUsd: 0 }),
        }),
      }),
    ),
  );
  expect((screen.getByLabelText("Publish packages") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("Share structured evidence") as HTMLInputElement).checked).toBe(
    false,
  );
  expect((screen.getByLabelText("Adopt qualified updates") as HTMLInputElement).checked).toBe(
    false,
  );
});
it("reports disabled package support without changing the gateway configuration", async () => {
  request.mockResolvedValue({ enabled: false, packages: [], releases: [] });
  render(<SkillCatalog circleId="circle" onClose={() => {}} />);
  await screen.findByText(/Complete packages are disabled/);
  expect(request).toHaveBeenCalledTimes(1);
});
