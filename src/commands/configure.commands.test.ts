import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const runConfigureWizard = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./configure.wizard.js", () => ({
  runConfigureWizard,
}));

import { configureCommandFromSectionsArg } from "./configure.commands.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("configureCommandFromSectionsArg", () => {
  it("errors on an invalid-only --section instead of silently launching the full wizard", async () => {
    runConfigureWizard.mockClear();
    const runtime = createRuntime();
    await configureCommandFromSectionsArg(["nonsense"], runtime);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Invalid --section"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runConfigureWizard).not.toHaveBeenCalled();
  });

  it("accepts the new wallet and memory sections", async () => {
    runConfigureWizard.mockClear();
    const runtime = createRuntime();
    await configureCommandFromSectionsArg(["wallet", "memory"], runtime);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runConfigureWizard).toHaveBeenCalledWith(
      { command: "configure", sections: ["wallet", "memory"] },
      runtime,
    );
  });

  it("no sections at all still opens the interactive wizard", async () => {
    runConfigureWizard.mockClear();
    const runtime = createRuntime();
    await configureCommandFromSectionsArg(undefined, runtime);
    expect(runConfigureWizard).toHaveBeenCalledWith({ command: "configure" }, runtime);
  });
});
