import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTeaching } from "./BrowserTeaching";

const gateway = vi.hoisted(() => ({ status: "connected", request: vi.fn() }));
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (select: (state: typeof gateway) => unknown) => select(gateway),
}));
const record = {
  id: "demo",
  title: "Find invoice",
  goal: "Find supplier invoice",
  outcome: "Matching invoice shown",
  status: "stopped",
  actionCount: 2,
};
const options = {
  name: "taught-find-invoice",
  description: "Use for supplier invoices; not for unrelated workflows.",
  parameters: {},
};
beforeEach(() => {
  gateway.status = "connected";
  gateway.request.mockReset();
  let status = "stopped";
  gateway.request.mockImplementation(async (method: string) => {
    if (method.endsWith(".list")) return { recordings: [{ ...record, status }] };
    if (method.endsWith(".start")) {
      status = "recording";
      return record;
    }
    if (method.endsWith(".stop")) {
      status = "stopped";
      return record;
    }
    if (method.endsWith(".draft"))
      return {
        record,
        options,
        parameters: [{ id: "input_1", label: "Supplier" }],
        content: "Initial instructions",
      };
    if (method.endsWith(".stage"))
      return {
        ok: true,
        content: "Checked {{supplier}} instructions",
        hash: "abc",
        summary: "Checks passed",
      };
    if (method.endsWith(".activate")) {
      status = "saved";
      return { name: options.name };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
});

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Teach this workflow" }));
  await screen.findByRole("button", { name: "Review" });
}

describe("browser teaching", () => {
  it("records, names parameters, checks and saves only after explicit review", async () => {
    render(<BrowserTeaching mine />);
    await open();
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: record.title } });
    fireEvent.change(screen.getByLabelText("What are you trying to do?"), {
      target: { value: record.goal },
    });
    fireEvent.change(screen.getByLabelText("How will you know it worked?"), {
      target: { value: record.outcome },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record demonstration" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop and review" }));
    await screen.findByLabelText("Name for input_1");
    fireEvent.change(screen.getByLabelText("Name for input_1"), { target: { value: "supplier" } });
    fireEvent.click(screen.getByRole("button", { name: "Check skill draft" }));
    const save = await screen.findByRole("button", { name: "Save local skill" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(gateway.request).toHaveBeenCalledWith("browser.teaching.stage", {
      id: record.id,
      options: { ...options, parameters: { input_1: "supplier" } },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(save);
    await screen.findByText(/Saved taught-find-invoice/);
    expect(gateway.request).toHaveBeenCalledWith("browser.teaching.activate", {
      id: record.id,
      hash: "abc",
      reviewed: true,
    });
  });

  it("invalidates approval after an edit and surfaces a failed check", async () => {
    render(<BrowserTeaching mine />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check skill draft" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Skill name"), {
      target: { value: "taught-another-invoice" },
    });
    expect(screen.queryByRole("button", { name: "Save local skill" })).toBeNull();
    gateway.request.mockImplementation(async (method: string) =>
      method.endsWith(".stage")
        ? { ok: false, content: "Blocked draft", summary: "Unsafe recorded label" }
        : { recordings: [record] },
    );
    fireEvent.click(screen.getByRole("button", { name: "Check skill draft" }));
    await screen.findByText("Unsafe recorded label");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(gateway.request.mock.calls.some(([method]) => method.endsWith(".activate"))).toBe(false);
  });

  it("requires takeover and a connected gateway before recording", async () => {
    const { rerender } = render(<BrowserTeaching mine={false} />);
    await open();
    expect(
      (screen.getByRole("button", { name: "Record demonstration" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    gateway.status = "disconnected";
    rerender(<BrowserTeaching mine />);
    await waitFor(() => expect(screen.getByText(/Reconnect to the gateway/)).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: "Record demonstration" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
