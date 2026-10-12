import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

const notes = vi.hoisted(() => [] as string[]);
vi.mock("../terminal/note.js", () => ({
  note: (message: string) => {
    notes.push(String(message));
  },
}));

import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";

describe("doctor deprecated-key wording (PLAN-56 Phase 3b drift fix)", () => {
  it('a preview says "Would remove" and leaves the file alone; --fix says "Removed"', async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".bitterbot");
      await fs.mkdir(configDir, { recursive: true });
      const file = path.join(configDir, "bitterbot.json");
      const body = JSON.stringify(
        { agents: { list: [{ id: "main", runtime: { engine: "pi" } }] } },
        null,
        2,
      );
      await fs.writeFile(file, body, "utf-8");

      notes.length = 0;
      await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true },
        confirm: async () => false,
      });
      const preview = notes.join("\n");
      expect(preview).toContain("Would remove agents.list[0].runtime.engine");
      expect(preview).not.toContain("Removed agents.list[0].runtime.engine");
      expect(await fs.readFile(file, "utf-8")).toBe(body);

      notes.length = 0;
      await loadAndMaybeMigrateDoctorConfig({
        options: { nonInteractive: true, repair: true },
        confirm: async () => false,
      });
      expect(notes.join("\n")).toContain("Removed agents.list[0].runtime.engine");
    });
  });
});
