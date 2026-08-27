import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildPatchObject, reloadKindForPath, SettingsForm } from "./SettingsForm";

const requestMock = vi.fn();
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));

const RULES = [
  { prefix: "a2a", kind: "none" as const },
  { prefix: "circles", kind: "none" as const },
  { prefix: "cron", kind: "hot" as const },
  { prefix: "gateway", kind: "restart" as const },
];

const SCHEMA = {
  uiHints: {
    a2a: { label: "Agent-to-Agent", order: 180 },
    circles: { label: "Circles", order: 175 },
    gateway: { label: "Gateway", order: 30 },
    // The adjudicated D-D requirement: flipped flags are toggles here.
    "a2a.enabled": { label: "Agent-to-Agent (A2A) Endpoint", help: "Serve the Agent Card." },
    "circles.enabled": { label: "Circles Enabled" },
    "gateway.port": { label: "Gateway Port" },
    "gateway.auth.token": { label: "Gateway Token", sensitive: true },
  },
  reloadRules: RULES,
};

const SNAPSHOT = {
  exists: true,
  valid: true,
  baseHash: "h1",
  config: {
    a2a: { enabled: false },
    circles: { enabled: true },
    gateway: { port: 19001, auth: { token: "***redacted***" } },
  },
};

describe("buildPatchObject", () => {
  it("nests dotted paths into a merge-patch object", () => {
    const dirty = new Map<string, unknown>([
      ["a2a.enabled", true],
      ["gateway.port", 20000],
      ["gateway.auth.token", "new"],
    ]);
    expect(buildPatchObject(dirty)).toEqual({
      a2a: { enabled: true },
      gateway: { port: 20000, auth: { token: "new" } },
    });
  });
});

describe("reloadKindForPath", () => {
  it("first matching prefix wins; unmatched falls through to restart", () => {
    expect(reloadKindForPath("circles.enabled", RULES)).toBe("none");
    expect(reloadKindForPath("cron.jobs", RULES)).toBe("hot");
    expect(reloadKindForPath("gateway.port", RULES)).toBe("restart");
    expect(reloadKindForPath("unknown.path", RULES)).toBe("restart");
  });

  it("matches whole segments only (a2a does not match a2a2)", () => {
    expect(reloadKindForPath("crontab.x", RULES)).toBe("restart");
  });
});

describe("SettingsForm", () => {
  it("renders a toggle for a flipped flag and saves a nested patch", async () => {
    const onPatch = vi.fn(async () => true);
    render(<SettingsForm snapshot={SNAPSHOT} schema={SCHEMA} saving={false} onPatch={onPatch} />);
    const toggle = screen.getByRole("switch", { name: "Agent-to-Agent (A2A) Endpoint" });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onPatch).toHaveBeenCalledWith({ a2a: { enabled: true } }, false);
  });

  it("flags restart-required keys and raises the banner after such a save", async () => {
    const onPatch = vi.fn(async () => true);
    render(<SettingsForm snapshot={SNAPSHOT} schema={SCHEMA} saving={false} onPatch={onPatch} />);
    // gateway.port row carries the restart chip.
    expect(screen.getAllByTitle("Applying this change restarts the gateway").length).toBe(2);
    const port = screen.getByRole("spinbutton");
    await userEvent.clear(port);
    await userEvent.type(port, "20000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onPatch).toHaveBeenCalledWith({ gateway: { port: 20000 } }, true);
    expect(await screen.findByText(/need a gateway restart/)).toBeTruthy();
  });

  it("search filters rows by label", async () => {
    render(<SettingsForm snapshot={SNAPSHOT} schema={SCHEMA} saving={false} onPatch={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText("Search settings…"), "circles");
    expect(screen.queryByText("Agent-to-Agent (A2A) Endpoint")).toBeNull();
    expect(screen.getByText("Circles Enabled")).toBeTruthy();
  });

  it("renders sensitive values as password inputs with no plaintext", () => {
    render(<SettingsForm snapshot={SNAPSHOT} schema={SCHEMA} saving={false} onPatch={vi.fn()} />);
    const token = screen.getByPlaceholderText("•••••• (set)");
    expect((token as HTMLInputElement).type).toBe("password");
    expect((token as HTMLInputElement).value).toBe("");
  });
});
