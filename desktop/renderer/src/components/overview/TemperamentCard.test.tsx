import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGatewayStore } from "../../stores/gateway-store";
import { TemperamentCard } from "./TemperamentCard";

const PREVIEW = "## Temperament\n\nlevel: irreverent\n\n- Execute with precision.";

function gateway(present: boolean) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "genome.temperament.status") {
      return {
        genomeExists: true,
        present,
        preview: PREVIEW.replace("irreverent", String(params.level)),
      };
    }
    if (method === "genome.temperament.apply") {
      return {
        changed: true,
        status: { genomeExists: true, present: true, level: params.level, preview: PREVIEW },
      };
    }
    throw new Error(`unexpected ${method}`);
  });
  useGatewayStore.setState({ status: "connected", request, hello: null } as never);
  return request;
}

describe("TemperamentCard", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("offers the section to an agent without one: preview, then add", async () => {
    const request = gateway(false);
    render(<TemperamentCard />);
    await screen.findByText("A base personality is available for your agent");
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByTestId("temperament-preview").textContent).toContain("level: irreverent");

    fireEvent.change(screen.getByLabelText("Vibe"), { target: { value: "calm" } });
    await waitFor(() =>
      expect(screen.getByTestId("temperament-preview").textContent).toContain("level: calm"),
    );
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(screen.queryByTestId("temperament-card")).toBeNull());
    expect(request).toHaveBeenCalledWith("genome.temperament.apply", {
      action: "add",
      level: "calm",
    });
  });

  it("stays hidden once the section exists", async () => {
    const request = gateway(true);
    render(<TemperamentCard />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByTestId("temperament-card")).toBeNull();
  });

  it("Not now persists the dismissal and writes nothing", async () => {
    const request = gateway(false);
    const { unmount } = render(<TemperamentCard />);
    fireEvent.click(await screen.findByText("Not now"));
    expect(screen.queryByTestId("temperament-card")).toBeNull();
    expect(localStorage.getItem("bitterbot-temperament-offer-dismissed")).toBe("1");
    unmount();
    request.mockClear();
    render(<TemperamentCard />);
    expect(screen.queryByTestId("temperament-card")).toBeNull();
    expect(request).not.toHaveBeenCalledWith("genome.temperament.apply", expect.anything());
  });
});
