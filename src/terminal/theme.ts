import chalk, { Chalk } from "chalk";
import { BITTERBOT_PALETTE } from "./palette.js";

const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;

const hex = (value: string) => baseChalk.hex(value);

export const theme = {
  accent: hex(BITTERBOT_PALETTE.accent),
  accentBright: hex(BITTERBOT_PALETTE.accentBright),
  accentDim: hex(BITTERBOT_PALETTE.accentDim),
  info: hex(BITTERBOT_PALETTE.info),
  success: hex(BITTERBOT_PALETTE.success),
  warn: hex(BITTERBOT_PALETTE.warn),
  error: hex(BITTERBOT_PALETTE.error),
  muted: hex(BITTERBOT_PALETTE.muted),
  heading: baseChalk.bold.hex(BITTERBOT_PALETTE.accent),
  command: hex(BITTERBOT_PALETTE.accentBright),
  option: hex(BITTERBOT_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
