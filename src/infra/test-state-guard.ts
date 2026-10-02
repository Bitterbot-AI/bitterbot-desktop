/**
 * A test process must never open the developer's real state.
 *
 * The suite isolates HOME (test/test-env.ts), but isolation is an environment
 * variable and env can leak: on 2026-09-30 an e2e run resolved the live
 * `~/.bitterbot/memory/main.sqlite`, saw an index built by a different
 * embedding provider, and reindexed it. On 2026-08-26 a test destroyed the
 * live management node key the same way. This guard does not depend on the
 * environment being right. It asks the OS for the real home directory
 * (`os.userInfo()` reads the account record, not `$HOME`) and refuses any path
 * under that home's state dir while running under Vitest.
 *
 * Live suites (LIVE=1 and friends) run against real state on purpose and are
 * exempt.
 */

import os from "node:os";
import path from "node:path";

const STATE_DIRNAME = ".bitterbot";

function isNonLiveTestRun(env: NodeJS.ProcessEnv): boolean {
  if (!env.VITEST) {
    return false;
  }
  return !(
    env.LIVE === "1" ||
    env.BITTERBOT_LIVE_TEST === "1" ||
    env.BITTERBOT_LIVE_GATEWAY === "1"
  );
}

function realUserHome(): string | null {
  try {
    const home = os.userInfo().homedir;
    return home ? path.resolve(home) : null;
  } catch {
    // No account record (some containers). Nothing to protect against.
    return null;
  }
}

export function assertNotRealStateUnderTest(
  targetPath: string,
  opts: { env?: NodeJS.ProcessEnv; realHome?: string | null } = {},
): void {
  if (!isNonLiveTestRun(opts.env ?? process.env)) {
    return;
  }
  const home = opts.realHome === undefined ? realUserHome() : opts.realHome;
  if (!home) {
    return;
  }
  const realState = path.join(home, STATE_DIRNAME);
  const resolved = path.resolve(targetPath);
  if (resolved === realState || resolved.startsWith(realState + path.sep)) {
    throw new Error(
      `Refusing to open ${resolved} from a test process: it is inside the real state directory ` +
        `(${realState}). Tests must run against an isolated HOME (test/test-env.ts).`,
    );
  }
}
