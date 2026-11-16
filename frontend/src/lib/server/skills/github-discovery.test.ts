import { it, expect, vi } from "vitest";
import { discoverGithubSkills } from "./github-provider";
import { githubFixture, fixtureInput } from "./github-fixture";
function discoveryFixture() {
  const f = githubFixture(),
    root = f.bundle.source.rootTreeSha;
  const rootEntries = (f.responses[`/git/trees/${root}`] as { tree: unknown[] }).tree;
  const parentKey = Object.keys(f.responses).find(
    (k) => k.startsWith("/git/trees/") && k !== `/git/trees/${root}` && !k.includes("?"),
  )!;
  const parentEntries = (f.responses[parentKey] as { tree: { path: string }[] }).tree.map((e) => ({
    ...e,
    path: `skills/${e.path}`,
  }));
  const leaf = (
    f.responses[`/git/trees/${f.bundle.source.skillTreeSha}?recursive=1`] as {
      tree: { path: string }[];
    }
  ).tree.map((e) => ({ ...e, path: `skills/synthetic-skill/${e.path}` }));
  f.responses[""] = {
    id: 42,
    full_name: "opc-test/synthetic",
    private: false,
    default_branch: "main",
  };
  f.responses["/branches/main"] = { commit: { sha: f.bundle.source.commitSha } };
  f.responses[`/git/commits/${f.bundle.source.commitSha}`] = {
    sha: f.bundle.source.commitSha,
    tree: { sha: root },
  };
  f.responses[`/git/trees/${root}?recursive=1`] = {
    sha: root,
    truncated: false,
    tree: [...rootEntries, ...parentEntries, ...leaf],
  };
  return f;
}
it("discovers a public repository, verifies the full tree and returns fixed candidate inputs", async () => {
  const f = discoveryFixture(),
    fetcher = vi.fn(async (url) => {
      const key = String(url).slice(f.base.length);
      if (!(key in f.responses)) throw Error("UNEXPECTED_URL");
      return Response.json(f.responses[key]);
    });
  const result = await discoverGithubSkills("https://github.com/opc-test/synthetic", { fetcher });
  expect(result.candidates).toEqual([{ ...fixtureInput, ref: f.bundle.source.commitSha }]);
  expect(fetcher).toHaveBeenCalledTimes(4);
  const pinned = await discoverGithubSkills(
    `https://github.com/opc-test/synthetic/blob/${result.ref}/skills/synthetic-skill/SKILL.md`,
    { fetcher },
  );
  expect(pinned.candidates).toEqual(result.candidates);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/git/blobs/"))).toBe(false);
});
it.each([
  "http://github.com/a/b",
  "https://evil.test/a/b",
  "https://github.com:444/a/b",
  "https://user:secret@github.com/a/b",
  "https://github.com/a/b?token=no",
  "https://github.com/a/b/tree/main/%2e%2e",
  "https://github.com/a/b/issues",
])("rejects unsafe discovery URL before any network: %s", async (value) => {
  const fetcher = vi.fn();
  await expect(discoverGithubSkills(value, { fetcher })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["identity", "truncated", "tampered"])("fails closed on discovery %s", async (mode) => {
  const f = discoveryFixture();
  if (mode === "identity") f.responses[""] = { private: false, full_name: "other/repo" };
  const tree = f.responses[`/git/trees/${f.bundle.source.rootTreeSha}?recursive=1`] as {
    truncated: boolean;
    tree: { sha: string }[];
  };
  if (mode === "truncated") tree.truncated = true;
  if (mode === "tampered") tree.tree[0].sha = "f".repeat(40);
  const fetcher = vi.fn(async (url) =>
    Response.json(f.responses[String(url).slice(f.base.length)]),
  );
  await expect(
    discoverGithubSkills("https://github.com/opc-test/synthetic", { fetcher }),
  ).rejects.toThrow();
});
