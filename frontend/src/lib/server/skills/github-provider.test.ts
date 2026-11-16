import { afterEach, expect, it, vi } from "vitest";
import {
  fetchGithubSkill,
  parseGithubSkill,
  gitTreeSha,
  SOURCE_LICENSE_RESOURCE,
} from "./github-provider";
import { createHash } from "node:crypto";
import { fixtureApproval, fixtureInput, githubFixture } from "./github-fixture";
import { normalizeGithubImportInput, requireGithubSourceApproval } from "./github-source-policy";
afterEach(() => vi.restoreAllMocks());
it("unknown sources remain denied independently of the public catalog", async () => {
  expect(() => requireGithubSourceApproval(fixtureInput)).toThrow(
    "GITHUB_SOURCE_APPROVAL_REQUIRED",
  );
  const fetcher = vi.fn();
  await expect(fetchGithubSkill(fixtureInput, [], { fetcher })).rejects.toMatchObject({
    code: "GITHUB_SOURCE_APPROVAL_REQUIRED",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["url", "owner", "path", "encoded", "ref", "unknown", "emptyRef"])(
  "rejects arbitrary or unsafe source %s before network",
  async (kind) => {
    const input: Record<string, unknown> = { ...fixtureInput };
    if (kind === "url") input.repositoryName = "https://127.0.0.1";
    if (kind === "owner") input.ownerId = "another-owner";
    if (kind === "path") input.path = "skills/../secret";
    if (kind === "encoded") input.path = "skills/%2e%2e";
    if (kind === "ref") input.ref = "main/../evil";
    if (kind === "unknown") input.Authorization = "NEVER_TRANSMIT";
    if (kind === "emptyRef") input.ref = "";
    const fetcher = vi.fn();
    await expect(fetchGithubSkill(input, [fixtureApproval], { fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("normalizes repository case but does not silently rewrite ref/path", () => {
  expect(normalizeGithubImportInput({ ...fixtureInput, repositoryOwner: "OPC-Test" })).toEqual(
    fixtureInput,
  );
});
it("uses bounded Git commit metadata for an already pinned SHA, without fetching a diff", async () => {
  const f = githubFixture();
  const ref = f.bundle.source.commitSha;
  f.responses[`/git/commits/${ref}`] = { sha: ref, tree: { sha: f.bundle.source.rootTreeSha } };
  const fetcher = vi.fn(async (url) =>
    Response.json(f.responses[String(url).slice(f.base.length)]),
  );
  const bundle = await fetchGithubSkill({ ...fixtureInput, ref }, [{ ...fixtureApproval, ref }], {
    fetcher,
  });
  expect(bundle.source.commitSha).toBe(ref);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/commits/main"))).toBe(false);
  f.responses[`/git/commits/${ref}`] = {
    sha: "f".repeat(40),
    tree: { sha: f.bundle.source.rootTreeSha },
  };
  await expect(
    fetchGithubSkill({ ...fixtureInput, ref }, [{ ...fixtureApproval, ref }], { fetcher }),
  ).rejects.toMatchObject({ code: "GITHUB_COMMIT_MISMATCH" });
});
it("pins once, fetches only canonical tree/blob API URLs and validates every resource", async () => {
  const f = githubFixture("# Do not execute\nhttps://evil.test/DO_NOT_FETCH\n");
  const fetcher = vi.fn(async (url) => {
    const suffix = String(url).slice(f.base.length);
    if (!(suffix in f.responses)) throw new Error("UNEXPECTED_URL");
    return Response.json(f.responses[suffix]);
  });
  const bundle = await fetchGithubSkill(fixtureInput, [fixtureApproval], { fetcher });
  expect(bundle.source).toEqual(f.bundle.source);
  expect(parseGithubSkill(bundle)).toMatchObject({
    profile: "opc-github-text-v1",
    warnings: ["GITHUB_CONTENT_UNREVIEWED", "LICENSE_SCOPE_REVIEW_REQUIRED"],
  });
  expect(fetcher).toHaveBeenCalledTimes(7);
  for (const [url, opts] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect(url.startsWith(f.base)).toBe(true);
    expect(opts).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(opts.headers).not.toHaveProperty("Authorization");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  }
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/commits/"))).toHaveLength(1);
});
it.each([
  "identity",
  "private",
  "commit",
  "truncated",
  "paginated",
  "symlink",
  "submodule",
  "binary",
  "tooMany",
  "size",
  "total",
  "path",
  "collision",
  "blobHash",
  "blobSize",
  "base64",
  "lfs",
  "yaml",
  "json",
  "huge",
  "redirect",
  "429",
  "exception",
])("fails closed on %s, never retries", async (kind) => {
  const f = githubFixture();
  const treeKey = Object.keys(f.responses).find((k) => k.endsWith("?recursive=1"))!;
  const tree = f.responses[treeKey] as { truncated: boolean; tree: Record<string, unknown>[] };
  const blobKey = Object.keys(f.responses).find((k) => k.startsWith("/git/blobs/"))!;
  const blob = f.responses[blobKey] as Record<string, unknown>;
  if (kind === "identity") (f.responses[""] as Record<string, unknown>).id = 99;
  if (kind === "private") (f.responses[""] as Record<string, unknown>).private = true;
  if (kind === "commit")
    f.responses["/commits/main"] = { sha: "bad", commit: { tree: { sha: "x" } } };
  if (kind === "truncated") tree.truncated = true;
  if (kind === "symlink") tree.tree[0].mode = "120000";
  if (kind === "submodule") {
    tree.tree[0].type = "commit";
    tree.tree[0].mode = "160000";
  }
  if (kind === "binary") tree.tree.push({ ...tree.tree[0], path: "asset.png" });
  if (kind === "tooMany")
    tree.tree = Array.from({ length: 65 }, (_, i) => ({ ...tree.tree[0], path: `file-${i}.md` }));
  if (kind === "size") tree.tree[0].size = 131073;
  if (kind === "total")
    tree.tree.push(
      ...Array.from({ length: 9 }, (_, i) => ({
        ...tree.tree[0],
        path: `extra-${i}.md`,
        size: 131072,
      })),
    );
  if (kind === "path") tree.tree[0].path = "../escape.md";
  if (kind === "collision") tree.tree.push({ ...tree.tree[0], path: "skill.MD" });
  if (kind === "blobHash") blob.content = Buffer.alloc(Number(blob.size), 65).toString("base64");
  if (kind === "blobSize") blob.size = 1;
  if (kind === "base64") blob.content = "!!!";
  if (["lfs", "yaml"].includes(kind)) {
    const altered = githubFixture(kind === "lfs" ? "x" : "x");
    // Parser-level checks separately verify exact bytes and Git hash, not only JSON fields.
    const bundle = altered.bundle;
    bundle.files[0].bytes = Buffer.from(
      kind === "lfs"
        ? "version https://git-lfs.github.com/spec/v1"
        : "---\nname: wrong\ndescription: invalid\n---\n",
    );
    bundle.files[0].gitBlobSha = createHash("sha1")
      .update(`blob ${bundle.files[0].bytes.length}\0`)
      .update(bundle.files[0].bytes)
      .digest("hex");
    expect(() => parseGithubSkill(bundle)).toThrow(
      kind === "lfs" ? "LFS_POINTER_REJECTED" : "NAME_MISMATCH",
    );
    return;
  }
  const fetcher = vi.fn(async (url) => {
    if (kind === "exception") throw new Error("PRIVATE_SENTINEL");
    if (kind === "redirect")
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
    if (kind === "429") return new Response(null, { status: 429 });
    if (kind === "json")
      return new Response("SECRET", { headers: { "content-type": "application/json" } });
    if (kind === "huge")
      return new Response(" ".repeat(256 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      });
    return Response.json(f.responses[String(url).slice(f.base.length)], {
      headers: kind === "paginated" ? { link: '<https://evil.test>; rel="next"' } : {},
    });
  });
  await expect(fetchGithubSkill(fixtureInput, [fixtureApproval], { fetcher })).rejects.toSatisfy(
    (e: Error) => !e.message.includes("PRIVATE_SENTINEL"),
  );
  const urls = fetcher.mock.calls.map(([url]) => url);
  expect(new Set(urls).size).toBe(urls.length);
});
it.each([
  ["symlink", "NON_REGULAR_FILE"],
  ["submodule", "NON_REGULAR_FILE"],
  ["binary", "UNSUPPORTED_RESOURCE"],
  ["count", "BUNDLE_LIMIT_OR_SOURCE"],
  ["collision", "PATH_COLLISION"],
  ["size", "BUNDLE_SIZE_LIMIT"],
  ["total", "BUNDLE_SIZE_LIMIT"],
  ["main", "MAIN_REQUIRED"],
])("rejects a hash-consistent but unsafe tree: %s", async (kind, code) => {
  const f = githubFixture();
  type Entry = { path: string; mode: string; type: string; sha: string; size?: number };
  const skillKey = `/git/trees/${f.bundle.source.skillTreeSha}?recursive=1`;
  const t = f.responses[skillKey] as { sha: string; tree: Entry[] };
  if (kind === "symlink") t.tree[0].mode = "120000";
  if (kind === "submodule") {
    t.tree[0].mode = "160000";
    t.tree[0].type = "commit";
  }
  if (kind === "binary") t.tree.push({ ...t.tree[0], path: "asset.png" });
  if (kind === "count")
    t.tree = Array.from({ length: 64 }, (_, i) => ({ ...t.tree[0], path: `file-${i}.md` }));
  if (kind === "collision") t.tree.push({ ...t.tree[0], path: "skill.MD" });
  if (kind === "size") t.tree[0].size = 131073;
  if (kind === "total")
    t.tree.push(
      ...Array.from({ length: 9 }, (_, i) => ({
        ...t.tree[0],
        path: `extra-${i}.md`,
        size: 131072,
      })),
    );
  if (kind === "main") t.tree[0].path = "other.md";
  t.sha = gitTreeSha(t.tree);
  f.responses[`/git/trees/${t.sha}?recursive=1`] = t;
  const rootKey = `/git/trees/${f.bundle.source.rootTreeSha}`;
  const root = f.responses[rootKey] as { sha: string; tree: Entry[] };
  const parent = f.responses[`/git/trees/${root.tree.find((e) => e.path === "skills")!.sha}`] as {
    sha: string;
    tree: Entry[];
  };
  parent.tree[0].sha = t.sha;
  parent.sha = gitTreeSha(parent.tree);
  f.responses[`/git/trees/${parent.sha}`] = parent;
  root.tree.find((e) => e.path === "skills")!.sha = parent.sha;
  root.sha = gitTreeSha(root.tree);
  f.responses[`/git/trees/${root.sha}`] = root;
  f.responses["/commits/main"] = {
    sha: f.bundle.source.commitSha,
    commit: { tree: { sha: root.sha } },
  };
  const fetcher = vi.fn(async (url) =>
    Response.json(f.responses[String(url).slice(f.base.length)]),
  );
  await expect(
    fetchGithubSkill(fixtureInput, [fixtureApproval], { fetcher }),
  ).rejects.toMatchObject({ code });
});
it("retains the exact pinned root license and rejects changed or missing evidence", async () => {
  const f = githubFixture();
  const fetcher = vi.fn(async (url) =>
    Response.json(f.responses[String(url).slice(f.base.length)]),
  );
  const bundle = await fetchGithubSkill(fixtureInput, [fixtureApproval], { fetcher });
  expect(bundle.files.find((f) => f.path === SOURCE_LICENSE_RESOURCE)?.bytes).toEqual(
    f.bundle.files.at(-1)?.bytes,
  );
  await expect(
    fetchGithubSkill(fixtureInput, [{ ...fixtureApproval, licenseSha256: "0".repeat(64) }], {
      fetcher,
    }),
  ).rejects.toMatchObject({ code: "GITHUB_LICENSE_MISMATCH" });
  bundle.files = bundle.files.filter((f) => f.path !== SOURCE_LICENSE_RESOURCE);
  expect(() => parseGithubSkill(bundle)).toThrow("GITHUB_LICENSE_MISMATCH");
});
it("cancelled input performs no HTTP request", async () => {
  const c = new AbortController();
  c.abort();
  const fetcher = vi.fn();
  await expect(
    fetchGithubSkill(fixtureInput, [fixtureApproval], { fetcher, signal: c.signal }),
  ).rejects.toMatchObject({ code: "GITHUB_IMPORT_CANCELLED" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("a per-request timeout is sanitized", async () => {
  const controller = new AbortController();
  const real = AbortSignal.timeout;
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 10000 ? controller.signal : real(ms),
  );
  const fetcher = vi.fn(async () => {
    controller.abort();
    throw new Error("PRIVATE_SENTINEL");
  });
  await expect(
    fetchGithubSkill(fixtureInput, [fixtureApproval], { fetcher }),
  ).rejects.toMatchObject({ code: "GITHUB_REQUEST_TIMEOUT" });
});
