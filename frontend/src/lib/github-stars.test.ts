import { afterEach, expect, it, vi } from "vitest";
import { collectRepositoryStars, GITHUB_API_VERSION } from "../../scripts/lib/github-stars.mjs";
import release from "./server/skills/catalog/featured-20261105-01.json";

const repos = release.repositories;
const at = "2026-11-05T04:00:00.000Z";
const now = () => at;
function metadata(i = 0, stars = 123) {
  return Response.json({
    id: repos[i].id,
    full_name: repos[i].fullName,
    private: false,
    stargazers_count: stars,
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("requests each approved repo once with no auth/redirects, accepts real decreases and zero", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(metadata(0, 0))
    .mockResolvedValueOnce(metadata(1, 5))
    .mockResolvedValueOnce(metadata(2, 1));
  const result = await collectRepositoryStars(repos, release.observations, { fetcher, now });
  expect(result.map((o) => o.stars)).toEqual([0, 5, 1]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).toMatch(
      /^https:\/\/api.github.com\/repos\/(obra\/superpowers|anthropics\/skills|vercel-labs\/agent-skills)$/,
    );
    expect(options).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers["X-GitHub-Api-Version"]).toBe(GITHUB_API_VERSION);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  }
});
it("preserves old integer and original date on rate failure; unknown remains null, not zero", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
  const result = await collectRepositoryStars(repos.slice(0, 1), release.observations, {
    fetcher,
    now,
  });
  expect(result[0]).toMatchObject({
    stars: 312516,
    observedAt: release.observations[0].observedAt,
    lastAttempt: { at, result: "FAILED", errorCode: "GITHUB_RATE_LIMIT_OR_FORBIDDEN" },
  });
  const missing = await collectRepositoryStars(repos.slice(0, 1), [], { fetcher, now });
  expect(missing[0]).toMatchObject({ stars: null, observedAt: null });
});
it("rejects unapproved sources and duplicate repository IDs without fetching", async () => {
  const fetcher = vi.fn();
  await expect(
    collectRepositoryStars([{ id: 1, fullName: "evil/repo" }], [], { fetcher, now }),
  ).rejects.toThrow("CATALOG_SOURCE_NOT_ALLOWED");
  await expect(
    collectRepositoryStars([repos[0], repos[0]], [], { fetcher, now }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  "rename",
  "wrongId",
  "private",
  "negative",
  "fraction",
  "missing",
  "html",
  "oversized",
  "invalidJson",
  "exception",
])("keeps old data on %s without raw failure leakage", async (kind) => {
  const data = {
    id: repos[0].id,
    full_name: repos[0].fullName,
    private: false,
    stargazers_count: 5,
  };
  if (kind === "rename") data.full_name = "other/renamed";
  if (kind === "wrongId") data.id = 1;
  if (kind === "private") data.private = true;
  if (kind === "negative") data.stargazers_count = -1;
  if (kind === "fraction") data.stargazers_count = 1.2;
  const fetcher = vi.fn(async () => {
    if (kind === "exception") throw new Error("PRIVATE_SENTINEL");
    if (kind === "html")
      return new Response("PRIVATE_SENTINEL", { headers: { "content-type": "text/html" } });
    if (kind === "oversized")
      return new Response(" ".repeat(128 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      });
    if (kind === "invalidJson")
      return new Response("PRIVATE_SENTINEL", { headers: { "content-type": "application/json" } });
    return Response.json(kind === "missing" ? {} : data);
  });
  const [o] = await collectRepositoryStars(repos.slice(0, 1), release.observations, {
    fetcher,
    now,
  });
  expect(o.stars).toBe(312516);
  expect(o.observedAt).toBe(release.observations[0].observedAt);
  expect(o.lastAttempt.result).toBe("FAILED");
  expect(JSON.stringify(o)).not.toContain("PRIVATE_SENTINEL");
});
it("times out a request without retry and retains historical data", async () => {
  const aborted = new AbortController();
  aborted.abort();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(aborted.signal);
  const fetcher = vi.fn(async (_url, options) => {
    options.signal.throwIfAborted();
    return metadata();
  });
  const [o] = await collectRepositoryStars(repos.slice(0, 1), release.observations, {
    fetcher,
    now,
  });
  expect(o.lastAttempt.errorCode).toBe("GITHUB_TIMEOUT");
  expect(o.stars).toBe(312516);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
