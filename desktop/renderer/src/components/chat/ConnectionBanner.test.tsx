import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGatewayStore } from "../../stores/gateway-store";
import { ConnectionBanner } from "./ConnectionBanner";

describe("connection banner", () => {
  it("stays quiet on first connect and speaks up when a live connection drops", () => {
    useGatewayStore.setState({ status: "connecting" } as never);
    render(<ConnectionBanner />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => useGatewayStore.setState({ status: "connected" } as never));
    expect(screen.queryByRole("status")).toBeNull();

    act(() => useGatewayStore.setState({ status: "connecting" } as never));
    expect(screen.getByRole("status").textContent).toBe("Connection lost. Reconnecting…");

    act(() => useGatewayStore.setState({ status: "connected" } as never));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
