import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gw = vi.hoisted(() => ({ request: vi.fn(async () => ({ ok: true })) }));
const store = vi.hoisted(() => ({ updateSkill: vi.fn() }));
vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (sel: (s: typeof gw) => unknown) => sel(gw),
}));
vi.mock("../../stores/skills-store", async (orig) => ({
  ...(await orig<typeof import("../../stores/skills-store")>()),
  useSkillsStore: (sel: (s: typeof store) => unknown) => sel(store),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SkillApiKeyField } from "./SkillsView";

const skill = {
  key: "weather",
  name: "Weather",
  primaryEnv: "WEATHER_API_KEY",
  hasApiKey: false,
} as never;

beforeEach(() => {
  gw.request.mockClear();
  store.updateSkill.mockClear();
});

describe("SkillApiKeyField", () => {
  it("saves a key for a skill that needs one", async () => {
    render(<SkillApiKeyField skill={skill} />);
    const user = userEvent.setup();

    expect(screen.getByText(/Needs an API key/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add key" }));
    await user.type(screen.getByLabelText("API key for Weather"), "sk-abc");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(gw.request).toHaveBeenCalledWith("skills.update", {
      skillKey: "weather",
      apiKey: "sk-abc",
    });
    expect(store.updateSkill).toHaveBeenCalledWith("weather", { hasApiKey: true });
  });

  it("removes a key that is set", async () => {
    render(<SkillApiKeyField skill={{ ...(skill as object), hasApiKey: true } as never} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove" }));

    expect(gw.request).toHaveBeenCalledWith("skills.update", { skillKey: "weather", apiKey: "" });
  });
});
