import type { Skill } from "@mariozechner/pi-coding-agent";
import type {
  BitterbotSkillMetadata,
  ParsedSkillFrontmatter,
  SkillCapabilitiesDeclaration,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
  SkillOrigin,
} from "./types.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import {
  getFrontmatterString,
  normalizeStringList,
  parseFrontmatterBool,
  resolveBitterbotManifestBlock,
  resolveBitterbotManifestInstall,
  resolveBitterbotManifestOs,
  resolveBitterbotManifestRequires,
} from "../../shared/frontmatter.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = kindRaw.trim().toLowerCase();
  if (kind !== "brew" && kind !== "node" && kind !== "go" && kind !== "uv" && kind !== "download") {
    return undefined;
  }

  const spec: SkillInstallSpec = {
    kind: kind,
  };

  if (typeof raw.id === "string") {
    spec.id = raw.id;
  }
  if (typeof raw.label === "string") {
    spec.label = raw.label;
  }
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) {
    spec.bins = bins;
  }
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  if (typeof raw.formula === "string") {
    spec.formula = raw.formula;
  }
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.module === "string") {
    spec.module = raw.module;
  }
  if (typeof raw.url === "string") {
    spec.url = raw.url;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  return spec;
}

/**
 * PLAN-13 Phase B: parse the `bitterbot.capabilities` block.
 *
 * Each axis has two acceptable shapes:
 *  - boolean (deny axis on `false`, allow axis on `true` for wallet/shell/process)
 *  - object with axis-specific scope keys
 *
 * Anything malformed is dropped silently. We never expand a missing field
 * to "allow"; the profile resolver fills missing axes from the trust-tier
 * default, not from the parser.
 */
function parseCapabilities(input: unknown): SkillCapabilitiesDeclaration | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const out: SkillCapabilitiesDeclaration = {};

  if (raw.network === false) {
    out.network = false;
  } else if (raw.network && typeof raw.network === "object") {
    const net = raw.network as Record<string, unknown>;
    const outbound = normalizeStringList(net.outbound);
    out.network = outbound.length > 0 ? { outbound } : { outbound: [] };
  }

  if (raw.fs === false) {
    out.fs = false;
  } else if (raw.fs && typeof raw.fs === "object") {
    const fsRaw = raw.fs as Record<string, unknown>;
    const read = normalizeStringList(fsRaw.read);
    const write = normalizeStringList(fsRaw.write);
    const fs: { read?: string[]; write?: string[] } = {};
    if (read.length > 0) fs.read = read;
    if (write.length > 0) fs.write = write;
    out.fs = fs;
  }

  if (typeof raw.wallet === "boolean") {
    out.wallet = raw.wallet;
  }
  if (typeof raw.shell === "boolean") {
    out.shell = raw.shell;
  }
  if (typeof raw.process === "boolean") {
    out.process = raw.process;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseOrigin(input: unknown): SkillOrigin | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const origin: SkillOrigin = {};
  if (typeof raw.registry === "string" && raw.registry.trim()) {
    origin.registry = raw.registry.trim();
  }
  if (typeof raw.slug === "string" && raw.slug.trim()) {
    origin.slug = raw.slug.trim();
  }
  if (typeof raw.version === "string" && raw.version.trim()) {
    origin.version = raw.version.trim();
  }
  if (typeof raw.license === "string" && raw.license.trim()) {
    origin.license = raw.license.trim();
  }
  const upstream =
    typeof raw.upstreamUrl === "string"
      ? raw.upstreamUrl
      : typeof raw.upstream_url === "string"
        ? raw.upstream_url
        : undefined;
  if (upstream && upstream.trim()) {
    origin.upstreamUrl = upstream.trim();
  }
  return Object.keys(origin).length > 0 ? origin : undefined;
}

export function resolveBitterbotMetadata(
  frontmatter: ParsedSkillFrontmatter,
): BitterbotSkillMetadata | undefined {
  const metadataObj = resolveBitterbotManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveBitterbotManifestRequires(metadataObj);
  const install = resolveBitterbotManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveBitterbotManifestOs(metadataObj);
  const origin = parseOrigin(metadataObj.origin);
  const capabilities = parseCapabilities(metadataObj.capabilities);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : undefined,
    homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : undefined,
    skillKey: typeof metadataObj.skillKey === "string" ? metadataObj.skillKey : undefined,
    primaryEnv: typeof metadataObj.primaryEnv === "string" ? metadataObj.primaryEnv : undefined,
    os: osRaw.length > 0 ? osRaw : undefined,
    requires: requires,
    install: install.length > 0 ? install : undefined,
    origin: origin,
    capabilities: capabilities,
  };
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterString(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterString(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}
