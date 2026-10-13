import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";

const printed = vi.hoisted(() => ({ notes: [] as string[], sections: [] as string[] }));

vi.mock("../terminal/note.js", () => ({
  note: (message: string, title?: string) => {
    printed.notes.push(`${title ?? ""}: ${message}`);
  },
}));

vi.mock("./doctor-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-check.js")>();
  return {
    ...actual,
    renderSection: (title: string) => {
      printed.sections.push(title);
    },
  };
});

import { resetDeprecatedConfigWarningsForTests, warnOnDeprecatedConfigKeys } from "../config/io.js";
import { loadAndMaybeMigrateDoctorConfig, type DoctorConfigOutput } from "./doctor-config-flow.js";

async function runWith(output: DoctorConfigOutput) {
  printed.notes = [];
  printed.sections = [];
  const lines: string[] = [];
  await loadAndMaybeMigrateDoctorConfig({
    options: { nonInteractive: true },
    confirm: async () => false,
    output,
    log: (line) => lines.push(line),
  });
  return lines;
}

describe("doctor config flow output modes (the config check before commands)", () => {
  it("guard: one line for deprecated keys, no box, and loading the config does not list them again", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".bitterbot");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "bitterbot.json"),
        JSON.stringify({
          memory: { backend: "builtin" },
          update: { uiRestart: { enabled: true } },
        }),
      );
      resetDeprecatedConfigWarningsForTests();
      const lines = await runWith("guard");
      expect(lines).toEqual([
        "2 old settings in your config are no longer used. Tidy them later with: bitterbot doctor --fix",
      ]);
      expect(printed.sections).toEqual([]);
      expect(printed.notes.join("\n")).not.toContain("deprecated");
      const warn = vi.fn();
      warnOnDeprecatedConfigKeys(
        { memory: { backend: "builtin" }, update: { uiRestart: { enabled: true } } },
        { warn },
      );
      expect(warn).not.toHaveBeenCalled();

      // The full doctor still shows the box.
      await runWith("doctor");
      expect(printed.sections).toContain("Config");
    });
  });

  it("summary prints exactly one line and nothing else; silent prints nothing", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".bitterbot");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "bitterbot.json"),
        JSON.stringify({ memory: { backend: "builtin" }, unknownTopLevelKey: true }),
      );
      const summary = await runWith("summary");
      expect(summary).toEqual([
        "1 old setting in your config is no longer used. Tidy it later with: bitterbot doctor --fix",
      ]);
      expect(printed.notes).toEqual([]);
      expect(printed.sections).toEqual([]);
      expect(await runWith("silent")).toEqual([]);
      expect(printed.notes).toEqual([]);
    });
  });
});
