import { readPersisted, writePersisted, type ThemePref } from "./persist";

const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");

export function resolveDark(pref: ThemePref = readPersisted().theme ?? "system"): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return media()?.matches ?? true;
}

/** Put the `dark` class (the shared tokens key off it) where the system or the owner wants it. */
export function applyTheme(pref?: ThemePref) {
  const dark = resolveDark(pref);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setThemePref(pref: ThemePref) {
  writePersisted({ theme: pref });
  applyTheme(pref);
}

/** Follow the system while the preference is "system". */
export function watchSystemTheme(): () => void {
  const m = media();
  if (!m) return () => {};
  const onChange = () => {
    if ((readPersisted().theme ?? "system") === "system") applyTheme("system");
  };
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
