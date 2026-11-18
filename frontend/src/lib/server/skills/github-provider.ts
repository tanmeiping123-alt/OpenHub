import "server-only";
import { createHash } from "node:crypto";
import {
  normalizeGithubImportInput,
  requireGithubSourceApproval,
  type GithubImportInput,
  type GithubSourceApproval,
} from "./github-source-policy";
import {
  parseOfflineSkill,
  sha256,
  SKILL_LIMITS,
  SkillInputError,
  validateSkillPath,
  type OfflineSkillBundle,
  type ParsedSkill,
} from "./skill-parser";

export const GITHUB_SKILL_PROFILE = "opc-github-text-v1";
export const GITHUB_IMPORT_DEADLINE_MS = 60000;
export const SOURCE_LICENSE_RESOURCE = "references/SOURCE-LICENSE.txt";
const API_VERSION = "2026-03-10";
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fail(code: string): never {
  throw new SkillInputError(code);
}
export type GithubSkillSource = GithubImportInput & {
  kind: "GITHUB";
  repositoryId: number;
  approvalId: string;
  licensePath: string;
  licenseSha256: string;
  commitSha: string;
  rootTreeSha: string;
  skillTreeSha: string;
};
export type GithubSkillBundle = { source: GithubSkillSource; files: OfflineSkillBundle["files"] };
export type ParsedGithubSkill = Omit<ParsedSkill, "source"> & { source: GithubSkillSource };

type GitTreeEntry = { path: string; mode: string; sha: string; type: string };
// Git sorts directory names as if suffixed with '/', and serializes octal mode
// without the API's leading zero. Validate tree contents, not only the echoed SHA.
export function gitTreeSha(entries: GitTreeEntry[]) {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(
      Buffer.from(a.path + (a.type === "tree" ? "/" : "")),
      Buffer.from(b.path + (b.type === "tree" ? "/" : "")),
    ),
  );
  const bytes = Buffer.concat(
    sorted.flatMap((e) => [
      Buffer.from(`${e.mode.replace(/^0+/, "")} ${e.path}\0`),
      Buffer.from(e.sha, "hex"),
    ]),
  );
  return createHash("sha1").update(`tree ${bytes.length}\0`).update(bytes).digest("hex");
}

function verifyTreeEntries(entries: GitTreeEntry[], sha: string, recursive: boolean) {
  const groups = new Map<string, GitTreeEntry[]>();
  groups.set("", []);
  const directories = new Map<string, string>();
  directories.set("", sha);
  for (const e of entries) {
    if (!/^(?:[\s\S]+)$/.test(e.path) || /\0/.test(e.path)) fail("GITHUB_INVALID_TREE");
    const slash = e.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : e.path.slice(0, slash);
    const base = slash < 0 ? e.path : e.path.slice(slash + 1);
    if (!base || base === "." || base === "..") fail("GITHUB_INVALID_TREE");
    const group = groups.get(parent) ?? [];
    group.push({ ...e, path: base });
    groups.set(parent, group);
    if (e.type === "tree") {
      directories.set(e.path, e.sha);
      if (!groups.has(e.path)) groups.set(e.path, []);
    }
  }
  if (!recursive) {
    if (gitTreeSha(entries) !== sha) fail("GIT_TREE_MISMATCH");
    return;
  }
  for (const [directory, children] of groups) {
    if (!directories.has(directory) || gitTreeSha(children) !== directories.get(directory))
      fail("GIT_TREE_MISMATCH");
  }
}

// Reuse the exact offline text/YAML/resource protections, not its source identity.
// Nothing with this temporary validation label is persisted as an OFFLINE import.
export function parseGithubSkill(bundle: GithubSkillBundle): ParsedGithubSkill {
  const source = structuredClone(bundle.source);
  const input = normalizeGithubImportInput({
    repositoryOwner: source.repositoryOwner,
    repositoryName: source.repositoryName,
    path: source.path,
    ref: source.ref,
  });
  if (
    source.kind !== "GITHUB" ||
    !Number.isSafeInteger(source.repositoryId) ||
    source.repositoryId <= 0 ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(source.approvalId) ||
    source.licensePath !== "LICENSE" ||
    !/^[a-f0-9]{64}$/.test(source.licenseSha256) ||
    ![source.commitSha, source.rootTreeSha, source.skillTreeSha].every(hash) ||
    source.repositoryOwner !== input.repositoryOwner ||
    source.repositoryName !== input.repositoryName ||
    bundle.files.some((f) => !hash(f.gitBlobSha))
  )
    fail("INVALID_GITHUB_SNAPSHOT");
  const license = bundle.files.find((f) => f.path === SOURCE_LICENSE_RESOURCE);
  if (!license || sha256(license.bytes) !== source.licenseSha256) fail("GITHUB_LICENSE_MISMATCH");
  const parsed = parseOfflineSkill({
    source: {
      kind: "OFFLINE",
      label: "github-text-validation",
      directoryName: source.path.split("/").at(-1)!,
    },
    files: bundle.files,
  });
  const manifest = { ...parsed.manifest, profile: GITHUB_SKILL_PROFILE, source };
  return {
    ...parsed,
    profile: GITHUB_SKILL_PROFILE,
    source,
    manifest,
    manifestSha256: sha256(JSON.stringify(manifest)),
    warnings: [
      ...parsed.warnings.filter((w) => w !== "SOURCE_UNVERIFIED"),
      "GITHUB_CONTENT_UNREVIEWED",
      "LICENSE_SCOPE_REVIEW_REQUIRED",
    ],
  };
}

async function readJson(response: Response, max: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body || !response.headers.get("content-type")?.includes("application/json"))
    fail("GITHUB_INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) fail("GITHUB_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      return fail("GITHUB_INVALID_RESPONSE");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function githubReader(
  input: GithubImportInput,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
) {
  const deadline = AbortSignal.timeout(GITHUB_IMPORT_DEADLINE_MS);
  const parent = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const fetcher = options.fetcher ?? fetch;
  const base = `https://api.github.com/repos/${input.repositoryOwner}/${input.repositoryName}`;
  let requests = 0;
  async function get(suffix: string, max = 256 * 1024): Promise<Record<string, unknown>> {
    parent.throwIfAborted();
    if (++requests > SKILL_LIMITS.files + SKILL_LIMITS.depth + 5) fail("GITHUB_REQUEST_LIMIT");
    const signal = AbortSignal.any([parent, AbortSignal.timeout(10000)]);
    try {
      const response = await fetcher(base + suffix, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "PromptMasterAI-Skill-Import",
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        fail(
          response.status === 403 || response.status === 429
            ? "GITHUB_RATE_LIMIT_OR_FORBIDDEN"
            : response.status >= 300 && response.status < 400
              ? "GITHUB_REDIRECT_REJECTED"
              : "GITHUB_HTTP_FAILED",
        );
      }
      if (response.headers.has("link")) {
        await response.body?.cancel();
        fail("GITHUB_SOURCE_INCOMPLETE");
      }
      const result = await readJson(response, max, signal);
      if (!object(result)) fail("GITHUB_INVALID_RESPONSE");
      return result;
    } catch (error) {
      if (parent.aborted)
        fail(options.signal?.aborted ? "GITHUB_IMPORT_CANCELLED" : "GITHUB_IMPORT_DEADLINE");
      if (signal.aborted) fail("GITHUB_REQUEST_TIMEOUT");
      if (error instanceof SkillInputError) throw error;
      return fail("GITHUB_FETCH_FAILED");
    }
  }
  return { get, parent };
}

export async function discoverGithubSkills(
  value: unknown,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
) {
  if (typeof value !== "string" || value.length > 1000) fail("INVALID_GITHUB_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("INVALID_GITHUB_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%|\\/.test(url.pathname)
  )
    fail("INVALID_GITHUB_URL");
  const pieces = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (pieces.length < 2 || pieces.length === 3 || pieces.length > 14) fail("INVALID_GITHUB_URL");
  const [repositoryOwner, repositoryName, kind, ref, ...rest] = pieces;
  if (kind && !["tree", "blob"].includes(kind)) fail("INVALID_GITHUB_URL");
  const input = normalizeGithubImportInput({
    repositoryOwner,
    repositoryName: repositoryName.replace(/\.git$/, ""),
    path: "skills",
    ref: ref ?? "main",
  });
  const { get } = githubReader(input, options);
  const repo = await get("");
  if (
    repo.private !== false ||
    typeof repo.full_name !== "string" ||
    repo.full_name.toLowerCase() !== `${input.repositoryOwner}/${input.repositoryName}`
  )
    fail("GITHUB_REPOSITORY_IDENTITY_CHANGED");
  const selectedRef = ref ?? repo.default_branch;
  if (typeof selectedRef !== "string" || selectedRef.length > 160) fail("INVALID_GITHUB_SOURCE");
  let commitSha = selectedRef;
  if (!hash(commitSha)) {
    const branch = await get(`/branches/${encodeURIComponent(selectedRef)}`);
    if (!object(branch.commit) || !hash(branch.commit.sha)) fail("PINNED_COMMIT_REQUIRED");
    commitSha = branch.commit.sha;
  }
  const commit = await get(`/git/commits/${commitSha}`);
  if (commit.sha !== commitSha || !object(commit.tree) || !hash(commit.tree.sha))
    fail("GITHUB_COMMIT_MISMATCH");
  const tree = await get(`/git/trees/${commit.tree.sha}?recursive=1`, 2 * 1024 * 1024);
  if (
    tree.truncated !== false ||
    tree.sha !== commit.tree.sha ||
    !Array.isArray(tree.tree) ||
    tree.tree.length > 10000
  )
    fail("GITHUB_SOURCE_INCOMPLETE");
  const entries = tree.tree as GitTreeEntry[];
  const seen = new Set<string>();
  for (const e of entries) {
    if (
      !object(e) ||
      typeof e.path !== "string" ||
      !hash(e.sha) ||
      typeof e.mode !== "string" ||
      !["tree", "blob", "commit"].includes(e.type) ||
      seen.has(e.path)
    )
      fail("GITHUB_INVALID_TREE");
    seen.add(e.path);
  }
  verifyTreeEntries(entries, commit.tree.sha, true);
  let prefix = rest.join("/");
  if (kind === "blob") {
    if (!prefix.endsWith("/SKILL.md")) fail("INVALID_GITHUB_URL");
    prefix = prefix.slice(0, -9);
  }
  const candidates = entries
    .filter((e) => e.type === "blob" && e.mode === "100644" && e.path.endsWith("/SKILL.md"))
    .map((e) => e.path.slice(0, -9))
    .filter((path) => !prefix || path === prefix || path.startsWith(prefix + "/"))
    .filter((path) => {
      try {
        normalizeGithubImportInput({ ...input, path, ref: commitSha });
        return true;
      } catch {
        return false;
      }
    })
    .sort();
  if (candidates.length > 100) fail("TOO_MANY_SKILL_CANDIDATES");
  return {
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    ref: commitSha,
    candidates: candidates.map((path) => ({ ...input, path, ref: commitSha })),
  };
}

export async function fetchGithubSkill(
  value: unknown,
  approvals: readonly GithubSourceApproval[],
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GithubSkillBundle> {
  const input = normalizeGithubImportInput(value);
  const approval = requireGithubSourceApproval(input, approvals);
  const { get, parent } = githubReader(input, options);
  try {
    const repository = await get("");
    if (
      repository.id !== approval.repositoryId ||
      typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== `${input.repositoryOwner}/${input.repositoryName}` ||
      repository.private !== false
    )
      fail("GITHUB_REPOSITORY_IDENTITY_CHANGED");
    // A fixed SHA needs no branch resolution or changed-file diff payload. The
    // Git commit endpoint is bounded metadata; never raise limits for a large diff.
    const pinned = /^[a-f0-9]{40}$/.test(input.ref);
    const commit = await get(
      pinned ? `/git/commits/${input.ref}` : `/commits/${encodeURIComponent(input.ref)}`,
    );
    const commitMetadata = pinned ? commit : commit.commit;
    if (
      !hash(commit.sha) ||
      !object(commitMetadata) ||
      !object(commitMetadata.tree) ||
      !hash(commitMetadata.tree.sha)
    )
      fail("GITHUB_INVALID_COMMIT");
    if (pinned && commit.sha !== input.ref) fail("GITHUB_COMMIT_MISMATCH");
    const commitSha = commit.sha;
    const rootTreeSha = commitMetadata.tree.sha;
    let treeSha = rootTreeSha;
    async function tree(sha: string, recursive = false) {
      const t = await get(`/git/trees/${sha}${recursive ? "?recursive=1" : ""}`, 2 * 1024 * 1024);
      if (t.sha !== sha || t.truncated !== false || !Array.isArray(t.tree) || t.tree.length > 10000)
        fail("GITHUB_SOURCE_INCOMPLETE");
      const entries = t.tree as Record<string, unknown>[];
      const seen = new Set<string>();
      for (const e of entries) {
        if (
          !object(e) ||
          typeof e.path !== "string" ||
          !hash(e.sha) ||
          !["blob", "tree", "commit"].includes(String(e.type)) ||
          typeof e.mode !== "string" ||
          (!recursive && e.path.includes("/")) ||
          seen.has(e.path)
        )
          fail("GITHUB_INVALID_TREE");
        seen.add(e.path);
      }
      verifyTreeEntries(entries as GitTreeEntry[], sha, recursive);
      return entries;
    }
    let licenseEntry: Record<string, unknown> | undefined;
    for (const segment of input.path.split("/")) {
      const entries = await tree(treeSha);
      if (treeSha === rootTreeSha)
        licenseEntry = entries.find((e) => e.path === approval.licensePath);
      const entry = entries.find((e) => e.path === segment);
      if (!entry || entry.type !== "tree" || entry.mode !== "040000")
        fail("GITHUB_SKILL_DIRECTORY_NOT_FOUND");
      treeSha = entry.sha as string;
    }
    const entries = await tree(treeSha, true);
    if (!licenseEntry || licenseEntry.type !== "blob" || licenseEntry.mode !== "100644")
      fail("GITHUB_LICENSE_MISSING");
    if (
      entries.some(
        (e) => validateSkillPath(e.path as string) === validateSkillPath(SOURCE_LICENSE_RESOURCE),
      )
    )
      fail("PATH_COLLISION");
    entries.push({ ...licenseEntry, path: SOURCE_LICENSE_RESOURCE });
    const paths = new Set<string>();
    const files: GithubSkillBundle["files"] = [];
    let total = 0;
    const blobs = entries.filter((e) => e.type !== "tree");
    if (blobs.length < 1 || blobs.length > SKILL_LIMITS.files) fail("BUNDLE_LIMIT_OR_SOURCE");
    for (const e of entries) {
      const key = validateSkillPath(e.path as string);
      if (paths.has(key)) fail("PATH_COLLISION");
      paths.add(key);
      if (e.type === "tree") {
        if (e.mode !== "040000") fail("GITHUB_INVALID_TREE");
        continue;
      }
      if (e.type !== "blob" || !["100644", "100755"].includes(e.mode as string))
        fail("NON_REGULAR_FILE");
      if (
        !Number.isSafeInteger(e.size) ||
        Number(e.size) < 0 ||
        Number(e.size) > SKILL_LIMITS.resource
      )
        fail("BUNDLE_SIZE_LIMIT");
      total += Number(e.size);
      if (
        total > SKILL_LIMITS.total ||
        (e.path === "SKILL.md" && Number(e.size) > SKILL_LIMITS.main)
      )
        fail("BUNDLE_SIZE_LIMIT");
      if (
        e.path !== "SKILL.md" &&
        !/\.(md|txt|json|yaml|yml|csv|tsv|xml|svg|html|css|js|ts|py|sh|ps1|sql)$/i.test(
          e.path as string,
        )
      )
        fail("UNSUPPORTED_RESOURCE");
    }
    if (!blobs.some((e) => e.path === "SKILL.md")) fail("MAIN_REQUIRED");
    // Complete recursive listing, including every text resource. Never follow Markdown links.
    for (const entry of blobs) {
      const blob = await get(`/git/blobs/${entry.sha}`);
      if (
        blob.sha !== entry.sha ||
        blob.encoding !== "base64" ||
        blob.size !== entry.size ||
        typeof blob.content !== "string"
      )
        fail("GITHUB_INVALID_BLOB");
      const encoded = blob.content.replace(/[\r\n]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        fail("GITHUB_INVALID_BLOB");
      const bytes = Buffer.from(encoded, "base64");
      if (
        bytes.toString("base64") !== encoded ||
        bytes.length !== entry.size ||
        createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !==
          entry.sha
      )
        fail("GIT_BLOB_MISMATCH");
      files.push({
        path: entry.path as string,
        kind: "file",
        bytes,
        gitBlobSha: entry.sha as string,
      });
    }
    parent.throwIfAborted();
    const bundle: GithubSkillBundle = {
      source: {
        kind: "GITHUB",
        ...input,
        repositoryId: approval.repositoryId,
        approvalId: approval.approvalId,
        licensePath: approval.licensePath,
        licenseSha256: approval.licenseSha256,
        commitSha,
        rootTreeSha,
        skillTreeSha: treeSha,
      },
      files,
    };
    parseGithubSkill(bundle);
    return bundle;
  } catch (error) {
    if (parent.aborted)
      fail(options.signal?.aborted ? "GITHUB_IMPORT_CANCELLED" : "GITHUB_IMPORT_DEADLINE");
    if (error instanceof SkillInputError) throw error;
    return fail("GITHUB_FETCH_FAILED");
  }
}

// User-supplied sources still pass the same fixed-host, bounded Git checks.
// This only records content provenance; it never grants library publication.
export async function inspectGithubSource(
  value: unknown,
  approvalId: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GithubSourceApproval> {
  const input = normalizeGithubImportInput(value);
  if (!hash(input.ref)) fail("PINNED_COMMIT_REQUIRED");
  const { get } = githubReader(input, options);
  const repo = await get("");
  if (
    !Number.isSafeInteger(repo.id) ||
    Number(repo.id) <= 0 ||
    repo.private !== false ||
    typeof repo.full_name !== "string" ||
    repo.full_name.toLowerCase() !== `${input.repositoryOwner}/${input.repositoryName}`
  )
    fail("GITHUB_REPOSITORY_IDENTITY_CHANGED");
  const commit = await get(`/git/commits/${input.ref}`);
  if (commit.sha !== input.ref || !object(commit.tree) || !hash(commit.tree.sha))
    fail("GITHUB_COMMIT_MISMATCH");
  const tree = await get(`/git/trees/${commit.tree.sha}`, 2 * 1024 * 1024);
  if (
    tree.sha !== commit.tree.sha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.length > 10000
  )
    fail("GITHUB_SOURCE_INCOMPLETE");
  const entries = tree.tree as GitTreeEntry[];
  const seen = new Set<string>();
  for (const e of entries) {
    if (
      !object(e) ||
      typeof e.path !== "string" ||
      e.path.includes("/") ||
      typeof e.mode !== "string" ||
      !hash(e.sha) ||
      !["blob", "tree", "commit"].includes(e.type) ||
      seen.has(e.path)
    )
      fail("GITHUB_INVALID_TREE");
    seen.add(e.path);
  }
  verifyTreeEntries(entries, commit.tree.sha, false);
  const entry = entries.find((e) => e.path === "LICENSE") as
    (GitTreeEntry & { size: number }) | undefined;
  if (
    !entry ||
    entry.mode !== "100644" ||
    entry.type !== "blob" ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1 ||
    entry.size > SKILL_LIMITS.resource
  )
    fail("GITHUB_LICENSE_MISSING");
  const blob = await get(`/git/blobs/${entry.sha}`);
  if (
    blob.sha !== entry.sha ||
    blob.size !== entry.size ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string"
  )
    fail("GITHUB_INVALID_BLOB");
  const encoded = blob.content.replace(/[\r\n]/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length !== entry.size ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.sha
  )
    fail("GIT_BLOB_MISMATCH");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_UTF8");
  }
  return {
    ...input,
    repositoryId: Number(repo.id),
    approvalId,
    retention: "ALLOWED_FOR_DISABLED_REVIEW",
    licensePath: "LICENSE",
    licenseSha256: sha256(bytes),
  };
}
