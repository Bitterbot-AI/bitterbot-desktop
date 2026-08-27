import type { Command } from "commander";
import type { ProgramContext } from "./context.js";
import { formatDocsLink } from "../../terminal/links.js";
import { isRich, theme } from "../../terminal/theme.js";
import { formatCliBannerLine, hasEmittedCliBanner } from "../banner.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";

const CLI_NAME = resolveCliName();

// Happy-path examples only (PLAN-41 p0-28): the first screen a new operator
// reads should walk the V1 story — onboard, open the UI, check health —
// not dev profiles or port surgery.
const EXAMPLES = [
  ["bitterbot onboard", "Guided setup: provider + key, network consent, gateway."],
  ["bitterbot dashboard", "Open the Control UI in your browser."],
  ["bitterbot doctor", "Walk subsystem checks and suggested repairs."],
  ["bitterbot gateway", "Run the gateway (serves the Control UI) in this terminal."],
  [
    "bitterbot channels login --verbose",
    "Link personal WhatsApp Web and show QR + connection logs.",
  ],
  [
    'bitterbot message send --channel telegram --target @mychat --message "Hi"',
    "Send via your Telegram bot.",
  ],
] as const;

export function configureProgramHelp(program: Command, ctx: ProgramContext) {
  program
    .name(CLI_NAME)
    .description(
      "Local-first AI agent with persistent memory, dream cycles, chat channels, and a P2P skills mesh.",
    )
    .version(ctx.programVersion)
    .option(
      "--dev",
      "Dev profile: isolate state under ~/.bitterbot-dev, default gateway port 19001, and shift derived ports (browser/canvas)",
    )
    .option(
      "--profile <name>",
      "Use a named profile (isolates BITTERBOT_STATE_DIR/BITTERBOT_CONFIG_PATH under ~/.bitterbot-<name>)",
    );

  program.option("--no-color", "Disable ANSI colors", false);

  program.configureHelp({
    // sort options and subcommands alphabetically
    sortSubcommands: true,
    sortOptions: true,
    optionTerm: (option) => theme.option(option.flags),
    subcommandTerm: (cmd) => theme.command(cmd.name()),
  });

  program.configureOutput({
    writeOut: (str) => {
      const colored = str
        .replace(/^Usage:/gm, theme.heading("Usage:"))
        .replace(/^Options:/gm, theme.heading("Options:"))
        .replace(/^Commands:/gm, theme.heading("Commands:"));
      process.stdout.write(colored);
    },
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(theme.error(str)),
  });

  // `-v` is version only in first position — deeper it belongs to a
  // subcommand's verbose flag (PLAN-41 p0-28; see hasHelpOrVersion).
  if (
    process.argv.includes("-V") ||
    process.argv.includes("--version") ||
    process.argv[2] === "-v"
  ) {
    console.log(ctx.programVersion);
    process.exit(0);
  }

  program.addHelpText("beforeAll", () => {
    if (hasEmittedCliBanner()) {
      return "";
    }
    const rich = isRich();
    const line = formatCliBannerLine(ctx.programVersion, { richTty: rich });
    return `\n${line}\n`;
  });

  const fmtExamples = EXAMPLES.map(
    ([cmd, desc]) => `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`,
  ).join("\n");

  program.addHelpText("afterAll", ({ command }) => {
    if (command !== program) {
      return "";
    }
    const docs = formatDocsLink("/cli", "docs.bitterbot.ai/cli");
    return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
  });
}
