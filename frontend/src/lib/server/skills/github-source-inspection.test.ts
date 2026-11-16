import { expect, it, vi } from "vitest";
import { inspectGithubSource } from "./github-provider";
import { githubFixture, fixtureInput, fixtureApproval } from "./github-fixture";

function fixture() {
  const f = githubFixture();
  const input = { ...fixtureInput, ref: f.bundle.source.commitSha };
  f.responses[`/git/commits/${input.ref}`] = {
    sha: input.ref,
    tree: { sha: f.bundle.source.rootTreeSha },
  };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const key = String(url).slice(f.base.length);
    if (!(key in f.responses)) throw Error("UNEXPECTED_NETWORK_TARGET");
    return Response.json(f.responses[key]);
  });
  return { ...f, input, fetcher };
}
it("prepares fixed source provenance without importing, publishing or fetching skill instructions", async () => {
  const f = fixture();
  const result = await inspectGithubSource(f.input, "prepared-test", { fetcher: f.fetcher });
  expect(result).toEqual({ ...fixtureApproval, ...f.input, approvalId: "prepared-test" });
  expect(f.fetcher).toHaveBeenCalledTimes(4);
  expect(f.fetcher.mock.calls.every(([url]) => String(url).startsWith(f.base))).toBe(true);
});
it.each(["branch", "unsafePath", "extraOwner"])(
  "rejects %s before source preparation network",
  async (kind) => {
    const f = fixture();
    const input: Record<string, unknown> = { ...f.input };
    if (kind === "branch") input.ref = "main";
    if (kind === "unsafePath") input.path = "../../credentials";
    if (kind === "extraOwner") input.ownerId = "victim";
    await expect(
      inspectGithubSource(input, "prepared-test", { fetcher: f.fetcher }),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  "private",
  "renamed",
  "wrongCommit",
  "truncated",
  "tamperedTree",
  "duplicate",
  "tamperedBlob",
  "badEncoding",
])("rejects %s provenance", async (kind) => {
  const f = fixture();
  const repo = f.responses[""] as Record<string, unknown>;
  const tree = f.responses[`/git/trees/${f.bundle.source.rootTreeSha}`] as {
    truncated: boolean;
    tree: Record<string, unknown>[];
  };
  const blob = f.responses[
    `/git/blobs/${tree.tree.find((e) => e.path === "LICENSE")!.sha}`
  ] as Record<string, unknown>;
  if (kind === "private") repo.private = true;
  if (kind === "renamed") repo.full_name = "elsewhere/other";
  if (kind === "wrongCommit")
    f.responses[`/git/commits/${f.input.ref}`] = {
      sha: "f".repeat(40),
      tree: { sha: f.bundle.source.rootTreeSha },
    };
  if (kind === "truncated") tree.truncated = true;
  if (kind === "tamperedTree") tree.tree[0].sha = "f".repeat(40);
  if (kind === "duplicate") tree.tree.push(tree.tree[0]);
  if (kind === "tamperedBlob")
    blob.content = Buffer.alloc(Number(blob.size), 65).toString("base64");
  if (kind === "badEncoding") blob.encoding = "utf8";
  await expect(
    inspectGithubSource(f.input, "prepared-test", { fetcher: f.fetcher }),
  ).rejects.toThrow();
});
