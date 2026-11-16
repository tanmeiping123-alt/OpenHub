import "server-only";
import { createHash } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node } from "yaml";

export const SKILL_PROFILE = "opc-offline-text-v1";
export const SKILL_PARSER = "1.0.0";
export const SKILL_LIMITS = Object.freeze({
  files: 64,
  total: 1048576,
  main: 65536,
  resource: 131072,
  depth: 8,
});
export class SkillInputError extends Error {
  constructor(public readonly code: string) {
    super(code); // Never include source text, YAML diagnostics, paths, or credentials.
  }
}
export type OfflineSkillBundle = {
  source: { kind: "OFFLINE"; label: string; directoryName: string };
  files: {
    path: string;
    kind: "file" | "symlink" | "submodule";
    bytes: Uint8Array;
    gitBlobSha?: string;
  }[];
};
type ResourceType = "MAIN" | "REFERENCE" | "ASSET" | "SCRIPT_QUARANTINED";
export type SkillResource = {
  path: string;
  size: number;
  type: ResourceType;
  sha256: string;
  content: string;
  gitBlobSha: string | null;
};
export type SkillMetadata = {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedToolsDeclaration: string | null;
};
export type ParsedSkill = {
  profile: string;
  parserVersion: string;
  source: OfflineSkillBundle["source"];
  metadata: SkillMetadata;
  body: string;
  mainSha256: string;
  manifest: {
    profile: string;
    mainSha256: string;
    files: Omit<SkillResource, "content" | "gitBlobSha">[];
  };
  manifestSha256: string;
  warnings: string[];
  resources: SkillResource[];
};
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(code: string): never {
  throw new SkillInputError(code);
}
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Input is an explicit in-memory bundle, never a disk path, archive, URL, or executable.
// Copy bytes before the first await in the service to prevent caller mutation/TOCTOU.
export function snapshotBundle(input: OfflineSkillBundle): OfflineSkillBundle {
  if (
    !input ||
    input.source?.kind !== "OFFLINE" ||
    typeof input.source.label !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(input.source.label) ||
    typeof input.source.directoryName !== "string" ||
    input.source.directoryName.length > 64 ||
    !namePattern.test(input.source.directoryName) ||
    !Array.isArray(input.files) ||
    input.files.length < 1 ||
    input.files.length > SKILL_LIMITS.files
  )
    fail("BUNDLE_LIMIT_OR_SOURCE");
  let total = 0;
  const files = Array.from(input.files, (f) => {
    if (
      !f ||
      typeof f.path !== "string" ||
      f.path.length > 512 ||
      !(f.bytes instanceof Uint8Array) ||
      !["file", "symlink", "submodule"].includes(f.kind) ||
      (f.gitBlobSha !== undefined && !/^[a-f0-9]{40}$/.test(f.gitBlobSha))
    )
      fail("INVALID_FILE");
    total += f.bytes.byteLength;
    if (f.bytes.byteLength > SKILL_LIMITS.resource || total > SKILL_LIMITS.total)
      fail("BUNDLE_SIZE_LIMIT");
    return {
      path: f.path,
      kind: f.kind,
      bytes: Uint8Array.from(f.bytes),
      ...(f.gitBlobSha === undefined ? {} : { gitBlobSha: f.gitBlobSha }),
    };
  });
  return {
    source: {
      kind: "OFFLINE",
      label: input.source.label,
      directoryName: input.source.directoryName,
    },
    files,
  };
}

export function bundleFingerprint(bundle: OfflineSkillBundle) {
  return sha256(
    JSON.stringify({
      source: bundle.source,
      files: bundle.files
        .map((f) => ({
          path: f.path,
          kind: f.kind,
          sha256: sha256(f.bytes),
          gitBlobSha: f.gitBlobSha ?? null,
        }))
        .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
    }),
  );
}

export function validateSkillPath(path: string) {
  // NFKC must be unchanged: reject compatibility separators / lookalikes, not silently rewrite them.
  if (
    !path ||
    path.length > 512 ||
    path !== path.normalize("NFKC") ||
    /[\\%:\x00-\x1f\x7f-\x9f]/u.test(path) ||
    /[\p{Cf}]/u.test(path)
  )
    fail("UNSAFE_PATH");
  const parts = path.split("/");
  if (
    parts.length > SKILL_LIMITS.depth + 1 ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /[<>"|?*]/.test(p) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
        p.startsWith("."),
    )
  )
    fail("UNSAFE_PATH");
  // Conservative Unicode case fold also catches final-sigma/uppercase collisions.
  return path.toUpperCase().normalize("NFC");
}

function decode(bytes: Uint8Array) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("INVALID_UTF8");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || text.charCodeAt(0) === 0xfeff)
    fail("UNSUPPORTED_TEXT");
  if (text.startsWith("version https://git-lfs.github.com/spec/v1")) fail("LFS_POINTER_REJECTED");
  return text;
}

function parseHeader(header: string): Map<string, unknown> {
  try {
    const documents = parseAllDocuments(header, {
      version: "1.2",
      schema: "core",
      customTags: [],
      resolveKnownTags: false,
      merge: false,
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
      logLevel: "silent",
    });
    if (documents.length !== 1) fail("INVALID_FRONTMATTER");
    const doc = documents[0];
    if (
      doc.errors.length ||
      doc.warnings.length ||
      !isMap(doc.contents) ||
      doc.directives?.yaml.version !== "1.2"
    )
      fail("INVALID_FRONTMATTER");
    // Walk iteratively before conversion. Reject ALL aliases, anchors, tags and merge keys.
    const stack: { node: unknown; depth: number }[] = [{ node: doc.contents, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (depth > 8) fail("YAML_DEPTH_LIMIT");
      if (!node || typeof node !== "object") continue;
      const n = node as Node & { anchor?: string; tag?: string };
      if (isAlias(n) || n.anchor || n.tag) fail("UNSAFE_YAML");
      if (isMap(n))
        for (const pair of n.items) {
          if (
            !isScalar(pair.key) ||
            typeof pair.key.value !== "string" ||
            ["<<", "__proto__", "prototype", "constructor"].includes(pair.key.value)
          )
            fail("UNSAFE_YAML");
          stack.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
        }
      if (isSeq(n)) for (const value of n.items) stack.push({ node: value, depth: depth + 1 });
    }
    return doc.toJS({ mapAsMap: true, maxAliasCount: 0 }) as Map<string, unknown>;
  } catch (error) {
    if (error instanceof SkillInputError) throw error;
    return fail("INVALID_FRONTMATTER");
  }
}

export function parseOfflineSkill(input: OfflineSkillBundle): ParsedSkill {
  const bundle = snapshotBundle(input);
  const seen = new Set<string>();
  const resources: SkillResource[] = [];
  for (const f of bundle.files) {
    const collisionKey = validateSkillPath(f.path);
    if (seen.has(collisionKey)) fail("PATH_COLLISION");
    seen.add(collisionKey);
    if (f.kind !== "file") fail("NON_REGULAR_FILE");
    if (f.path === "SKILL.md" && f.bytes.length > SKILL_LIMITS.main) fail("MAIN_SIZE_LIMIT");
    // Only named text extensions, no arbitrary binary assets. Script source is quarantined.
    const script =
      f.path.toLowerCase().startsWith("scripts/") || /\.(js|ts|py|sh|ps1|sql)$/i.test(f.path);
    if (
      f.path !== "SKILL.md" &&
      !/\.(md|txt|json|yaml|yml|csv|tsv|xml|svg|html|css|js|ts|py|sh|ps1|sql)$/i.test(f.path)
    )
      fail("UNSUPPORTED_RESOURCE");
    if (
      f.gitBlobSha &&
      createHash("sha1").update(`blob ${f.bytes.length}\0`).update(f.bytes).digest("hex") !==
        f.gitBlobSha
    )
      fail("GIT_BLOB_MISMATCH");
    resources.push({
      path: f.path,
      size: f.bytes.length,
      type:
        f.path === "SKILL.md"
          ? "MAIN"
          : script
            ? "SCRIPT_QUARANTINED"
            : f.path.toLowerCase().startsWith("assets/")
              ? "ASSET"
              : "REFERENCE",
      sha256: sha256(f.bytes),
      content: decode(f.bytes),
      gitBlobSha: f.gitBlobSha ?? null,
    });
  }
  resources.sort((a, b) => compare(a.path, b.path));
  for (const r of resources) {
    const segments = r.path.split("/");
    for (let i = 1; i < segments.length; i++)
      if (seen.has(segments.slice(0, i).join("/").toUpperCase().normalize("NFC")))
        fail("PATH_COLLISION");
  }
  const main = resources.find((r) => r.path === "SKILL.md");
  if (!main) fail("MAIN_REQUIRED");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(main.content);
  if (!match) fail("FRONTMATTER_REQUIRED");
  const fields = parseHeader(match[1]);
  const text = (key: string, max: number, required = false) => {
    const v = fields.get(key);
    if (v === undefined && !required) return null;
    if (
      typeof v !== "string" ||
      !v.trim() ||
      v.length > max ||
      /[\p{Cc}\p{Cf}]/u.test(v.replace(/[\r\n\t]/g, ""))
    )
      return fail("INVALID_METADATA");
    return v;
  };
  const name = text("name", 64, true)!;
  if (!namePattern.test(name) || name !== bundle.source.directoryName) fail("NAME_MISMATCH");
  const metadata: Record<string, string> = Object.create(null);
  const rawMetadata = fields.get("metadata");
  if (rawMetadata !== undefined) {
    if (!(rawMetadata instanceof Map) || rawMetadata.size > 64) fail("INVALID_METADATA");
    for (const [key, value] of rawMetadata) {
      if (
        typeof key !== "string" ||
        !key ||
        key.length > 128 ||
        typeof value !== "string" ||
        value.length > 2048
      )
        fail("INVALID_METADATA");
      metadata[key] = value;
    }
  }
  const known = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
  const warnings = [
    "SOURCE_UNVERIFIED",
    ...([...fields.keys()].some((k) => !known.includes(k)) ? ["UNKNOWN_FIELDS_IGNORED"] : []),
  ];
  const license = text("license", 1024);
  if (!license) warnings.push("LICENSE_MISSING");
  if (resources.some((r) => r.type === "SCRIPT_QUARANTINED")) warnings.push("SCRIPTS_QUARANTINED");
  const manifest = {
    profile: SKILL_PROFILE,
    mainSha256: main.sha256,
    files: resources.map(({ path, size, type, sha256 }) => ({ path, size, type, sha256 })),
  };
  return {
    profile: SKILL_PROFILE,
    parserVersion: SKILL_PARSER,
    source: bundle.source,
    metadata: {
      name,
      description: text("description", 1024, true)!,
      license,
      compatibility: text("compatibility", 500),
      metadata,
      allowedToolsDeclaration: text("allowed-tools", 2048),
    },
    body: main.content.slice(match[0].length),
    mainSha256: main.sha256,
    manifest,
    manifestSha256: sha256(JSON.stringify(manifest)),
    warnings,
    resources,
  };
}
