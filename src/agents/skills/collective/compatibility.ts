import type { SkillEnvironment, SkillPackageManifest } from "./contracts.js";

/** Unknown requirements wait for a host adapter; installation never grants capabilities. */
export function compatibilityIssues(
  manifest: SkillPackageManifest,
  environment: SkillEnvironment,
): string[] {
  const issues: string[] = [];
  const aliases: Record<string, string> = { windows: "win32", macos: "darwin", mac: "darwin" };
  const normalize = (platform: string) => aliases[platform.toLowerCase()] ?? platform.toLowerCase();
  if (
    manifest.requirements.platforms.length &&
    !manifest.requirements.platforms
      .map(normalize)
      .includes(normalize(environment.runtime.platform ?? "unknown"))
  )
    issues.push("platform-unavailable");
  for (const [name, version] of Object.entries(manifest.requirements.tools)) {
    if (
      !environment.tools[name] ||
      (version !== "available" && version !== environment.tools[name])
    )
      issues.push(`tool-unavailable:${name}:${version}`);
  }
  for (const [name, version] of Object.entries(manifest.requirements.runtime))
    if (environment.runtime[name] !== version)
      issues.push(`runtime-unavailable:${name}:${version}`);
  if (manifest.files.some((f) => /(^|\/)(setup\.(?:sh|py|json)|SETUP\.md)$/i.test(f.path)))
    issues.push("setup-requires-separate-authorization");
  return issues;
}
