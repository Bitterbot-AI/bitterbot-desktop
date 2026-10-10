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

// PLAN-56 Phase 1: settings that tell the truth.
const TRUTH_SCHEMA = {
  schema: {
    type: "object",
    properties: {
      update: {
        type: "object",
        properties: {
          checkOnStart: { type: "boolean" },
          channel: { anyOf: [{ const: "stable" }, { const: "beta" }, { const: "dev" }] },
        },
      },
      review: {
        type: "object",
        properties: {
          spend: { anyOf: [{ type: "string", enum: ["ask", "allow"] }, { type: "null" }] },
        },
      },
      usage: {
        type: "object",
        properties: {
          budgets: {
            type: "object",
            properties: { daily: { type: "object", properties: { usd: { type: "number" } } } },
          },
        },
      },
      meta: { type: "object", properties: { lastTouchedAt: { type: "string" } } },
      memory: { type: "object", properties: { backend: { const: "builtin" } } },
      p2p: { type: "object", properties: { enabled: { type: "boolean" } } },
      gateway: {
        type: "object",
        properties: {
          controlUi: { type: "object", properties: { basePath: { type: "string" } } },
        },
      },
    },
  },
  uiHints: {
    update: { label: "Update", order: 25 },
    review: {
      label: "Review and Spending",
      order: 190,
      help: "Three layers: review.spend, grants, caps.",
    },
    usage: { label: "Usage and Budgets", order: 192 },
    meta: { label: "Config Metadata", order: 950 },
    memory: { label: "Memory", order: 160 },
    p2p: { label: "P2P Network", order: 170 },
    gateway: { label: "Gateway", order: 30 },
    "update.checkOnStart": { label: "Update Check on Start", default: true },
    "update.channel": { label: "Update Channel" },
    "review.spend": { label: "Review: Spending" },
    "usage.budgets.daily.usd": { label: "Daily Budget (USD)" },
    "meta.lastTouchedAt": { label: "Config Last Touched At", readOnly: true },
    "memory.backend": { label: "Memory Backend", deprecated: "inert" },
    "p2p.enabled": { label: "P2P Mesh Enabled", default: true },
    "gateway.controlUi.basePath": { label: "Control UI Base Path", advanced: true },
  },
  reloadRules: [
    { prefix: "review", kind: "none" as const },
    { prefix: "usage", kind: "none" as const },
    { prefix: "update", kind: "none" as const },
    { prefix: "meta", kind: "none" as const },
  ],
};

const TRUTH_SNAPSHOT = {
  exists: true,
  valid: true,
  baseHash: "h2",
  // config carries the gateway's load-time defaults (p2p.enabled), resolved is the file itself.
  config: {
    update: { channel: "beta" },
    meta: { lastTouchedAt: "2026-10-10T00:00:00.000Z" },
    memory: { backend: "builtin" },
    p2p: { enabled: true },
    gateway: { controlUi: { basePath: "/bb" } },
  },
  resolved: {
    update: { channel: "beta" },
    meta: { lastTouchedAt: "2026-10-10T00:00:00.000Z" },
    memory: { backend: "builtin" },
    gateway: { controlUi: { basePath: "/bb" } },
  },
};

describe("SettingsForm truth layer (PLAN-56 Phase 1)", () => {
  it("renders an unset default-on flag as ON with the default badge", () => {
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={vi.fn()}
      />,
    );
    const sw = screen.getByRole("switch", { name: "Update Check on Start" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const row = sw.closest("div.flex.items-center.gap-3") as HTMLElement;
    expect(row.textContent).toContain("default");
  });

  it("shows the default badge for a load-time default that is absent from the file", () => {
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={vi.fn()}
      />,
    );
    const sw = screen.getByRole("switch", { name: "P2P Mesh Enabled" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const row = sw.closest("div.flex.items-center.gap-3") as HTMLElement;
    expect(row.textContent).toContain("default");
    // A key that IS in the file carries no badge.
    const channel = screen.getByRole("combobox", { name: "Update Channel" });
    const channelRow = channel.closest("div.flex.items-center.gap-3") as HTMLElement;
    expect(channelRow.textContent).not.toContain("default");
  });

  it("pins a default explicitly when toggled and saved", async () => {
    const onPatch = vi.fn(async () => true);
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={onPatch}
      />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Update Check on Start" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onPatch).toHaveBeenCalledWith({ update: { checkOnStart: false } }, false);
  });

  it("renders an enum path as a select and saves the chosen value", async () => {
    const onPatch = vi.fn(async () => true);
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={onPatch}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Update Channel" }) as HTMLSelectElement;
    expect(select.value).toBe("beta");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["stable", "beta", "dev"]);
    await userEvent.selectOptions(select, "dev");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onPatch).toHaveBeenCalledWith({ update: { channel: "dev" } }, false);
  });

  it("renders a read-only meta path as text with no control", () => {
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={vi.fn()}
      />,
    );
    expect(screen.getByTestId("readonly:meta.lastTouchedAt").textContent).toBe(
      "2026-10-10T00:00:00.000Z",
    );
    expect(screen.queryByRole("textbox", { name: "Config Last Touched At" })).toBeNull();
  });

  it("hides deprecated keys and honours Show advanced", async () => {
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={vi.fn()}
      />,
    );
    expect(screen.queryByText("Memory Backend")).toBeNull();
    expect(screen.queryByText("Control UI Base Path")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Show advanced" }));
    expect(screen.getByText("Control UI Base Path")).toBeTruthy();
  });

  it("renders group help under the section title", () => {
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={vi.fn()}
      />,
    );
    // review.spend is unset with no default, so the section only appears once added.
    expect(screen.queryByText(/Three layers/)).toBeNull();
  });

  it("Add setting lists unset keys without a default, adds a row and saves the patch", async () => {
    const onPatch = vi.fn(async () => true);
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={onPatch}
      />,
    );
    expect(screen.queryByText("Daily Budget (USD)")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Add setting/ }));
    await userEvent.type(screen.getByLabelText("Search keys to add"), "budget");
    const panel = screen.getByTestId("add-setting-panel");
    expect(panel.textContent).toContain("usage.budgets.daily.usd");
    expect(panel.textContent).not.toContain("meta.lastTouchedAt");
    expect(panel.textContent).not.toContain("memory.backend");
    expect(panel.textContent).not.toContain("update.checkOnStart");
    await userEvent.click(screen.getByRole("button", { name: /Daily Budget \(USD\)/ }));
    const usd = screen.getByRole("spinbutton", { name: "Daily Budget (USD)" });
    await userEvent.clear(usd);
    await userEvent.type(usd, "5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onPatch).toHaveBeenCalledWith({ usage: { budgets: { daily: { usd: 5 } } } }, false);
  });

  it("an added nullable enum offers (not set) and the real options", async () => {
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={TRUTH_SCHEMA}
        saving={false}
        onPatch={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Add setting/ }));
    await userEvent.click(screen.getByRole("button", { name: /Review: Spending/ }));
    const select = screen.getByRole("combobox", { name: "Review: Spending" }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "ask", "allow"]);
    expect(select.value).toBe("ask");
    expect(screen.getByText(/Three layers/)).toBeTruthy();
  });

  it("an added text row stays clean until typed and can be removed again", async () => {
    render(
      <SettingsForm
        snapshot={TRUTH_SNAPSHOT}
        schema={{
          ...TRUTH_SCHEMA,
          schema: {
            type: "object",
            properties: {
              ...TRUTH_SCHEMA.schema.properties,
              ui: { type: "object", properties: { seamColor: { type: "string" } } },
            },
          },
          uiHints: {
            ...TRUTH_SCHEMA.uiHints,
            ui: { label: "UI" },
            "ui.seamColor": { label: "Accent Color" },
          },
        }}
        saving={false}
        onPatch={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Add setting/ }));
    await userEvent.click(screen.getByRole("button", { name: /Accent Color/ }));
    expect(screen.getByRole("textbox", { name: "Accent Color" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Remove Accent Color" }));
    expect(screen.queryByRole("textbox", { name: "Accent Color" })).toBeNull();
  });
});
