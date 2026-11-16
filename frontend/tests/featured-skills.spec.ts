import { expect, test } from "./fixtures";
import release from "../src/lib/server/skills/catalog/featured-20261105-01.json";

test("published real catalog is browse-only, stable across modes, and separate from Registry", async ({
  page,
  request,
}) => {
  const writes: string[] = [];
  const remote: string[] = [];
  let catalogReads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/skills/featured")) catalogReads++;
    if (r.url().includes("/api/") && r.method() !== "GET") writes.push(r.url());
    if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) remote.push(r.url());
  });
  const before = await (await request.get("/api/skills")).json();
  await page.goto("/en/app");
  await page.getByText("Explore Skills", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Featured Skills", exact: true });
  await expect(panel.getByText("Currently showing 3 entries", { exact: false })).toBeVisible();
  await expect(panel.locator("ol > li")).toHaveCount(3);
  await expect(panel.locator("h3")).toHaveText([
    "brainstorming",
    "frontend-design",
    "vercel-react-best-practices",
  ]);
  await expect(panel.getByText("312.5K+", { exact: true })).toBeVisible();
  const reads = catalogReads;
  const switcher = page.getByRole("button", { name: /^Professional mode · Current:/ });
  await switcher.click();
  await expect(switcher).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator("h3")).toHaveText([
    "brainstorming",
    "frontend-design",
    "vercel-react-best-practices",
  ]);
  expect(catalogReads).toBe(reads);
  const summary = panel.locator("summary").filter({ hasText: "View details · brainstorming" });
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Raw snapshot: 312516")).toBeVisible();
  await expect(panel.getByText("2026-11-05T03:27:23.288Z (UTC)", { exact: true })).toBeVisible();
  const source = panel.getByRole("link", { name: "View source · brainstorming", exact: true });
  await expect(source).toHaveAttribute(
    "href",
    `https://github.com/obra/superpowers/tree/${release.candidates[0].sourceCommit}/skills/brainstorming`,
  );
  await expect(source).toHaveAttribute("rel", "noopener noreferrer");
  await source.focus();
  await expect(source).toBeFocused();
  await panel.locator("summary").filter({ hasText: "writing-plans" }).click();
  await expect(
    panel.getByRole("link", { name: "View source · writing-plans", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /Use|Install|Import/ })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(remote).toEqual([]);
  expect(await (await request.get("/api/skills")).json()).toEqual(before);
  expect(before.error).toBeUndefined();
});

test("Chinese list, nested details and source links fit narrow, landscape and enlarged text", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const size of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/zh-CN/app");
    await page.getByText("探索 Skills", { exact: true }).click();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
      document.body.style.fontSize = "20px";
    });
    const panel = page.getByRole("region", { name: "精选 Skills", exact: true });
    await expect(panel.getByText("当前展示 3 项", { exact: false })).toBeVisible();
    await expect(panel.getByText("31.2w+", { exact: true })).toBeVisible();
    await expect(panel.getByText("18.7w+", { exact: true })).toBeVisible();
    await expect(panel.getByText("3.3w+", { exact: true })).toBeVisible();
    await panel
      .locator("summary")
      .filter({ hasText: "查看详情 · vercel-react-best-practices" })
      .click();
    await panel
      .locator("summary")
      .filter({ hasText: /^writing-guidelines$/ })
      .click();
    const source = panel.getByRole("link", { name: "查看来源 · writing-guidelines", exact: true });
    await source.scrollIntoViewIfNeeded();
    await expect(source).toBeVisible();
    await source.focus();
    await expect(source).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const box = await source.boundingBox();
    expect(box!.y + box!.height).toBeLessThan(size.height - 45);
  }
});

test("unavailable catalog is an error, retry recovers locally, later failure retains the saved publication", async ({
  page,
}) => {
  let available = false;
  await page.route("**/api/skills/featured", (route) => {
    return route.fulfill({
      status: available ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify(available ? release : { error: "FEATURED_CATALOG_UNAVAILABLE" }),
    });
  });
  await page.goto("/en/app");
  await page.getByText("Explore Skills", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Featured Skills", exact: true });
  await expect(panel.getByRole("alert")).toHaveText(
    "Featured catalog unavailable. This does not mean there are no candidates.",
  );
  available = true;
  await panel.getByRole("button", { name: "Reload saved list" }).click();
  await expect(panel.locator("ol > li")).toHaveCount(3);
  available = false;
  await panel.getByRole("button", { name: "Reload saved list" }).click();
  await expect(panel.getByRole("alert")).toContainText("Keeping the previously loaded publication");
  await expect(panel.getByText("312.5K+", { exact: true })).toBeVisible();
  await expect(panel.locator("ol > li")).toHaveCount(3);
});

test("test-only empty publication shows zero entries, not a fabricated Top 10", async ({
  page,
}) => {
  const empty = {
    schemaVersion: 1,
    id: "test-only-empty",
    publishedAt: release.publishedAt,
    repositories: [],
    candidates: [],
    observations: [],
    orderedEntryIds: [],
  };
  await page.route("**/api/skills/featured", (route) => route.fulfill({ json: empty }));
  await page.goto("/en/app");
  await page.getByText("Explore Skills", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Featured Skills", exact: true });
  await expect(panel.getByText("Currently showing 0 entries", { exact: false })).toBeVisible();
  await expect(
    panel.getByText("No candidates with observed stars are available", { exact: false }),
  ).toBeVisible();
  await expect(panel.locator("ol > li")).toHaveCount(0);
});

test("test-only failed refresh shows old observation dates and update failure", async ({
  page,
}) => {
  const stale = structuredClone(release);
  stale.observations[0].lastAttempt = {
    at: release.publishedAt,
    result: "FAILED",
    errorCode: "GITHUB_HTTP_FAILURE",
  } as unknown as (typeof stale.observations)[0]["lastAttempt"];
  await page.route("**/api/skills/featured", (route) => route.fulfill({ json: stale }));
  await page.goto("/en/app");
  await page.getByText("Explore Skills", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Featured Skills", exact: true });
  await panel.locator("summary").filter({ hasText: "View details · brainstorming" }).click();
  await expect(
    panel.getByText("Update failed; historical observation retained", { exact: false }),
  ).toBeVisible();
  await expect(panel.getByText("2026-11-05T03:27:23.288Z (UTC)", { exact: true })).toBeVisible();
});

test("malformed publication and untrusted link fail closed", async ({ page }) => {
  const bad = structuredClone(release);
  bad.observations[0].sourceUrl = "https://evil.test/";
  await page.route("**/api/skills/featured", (route) => route.fulfill({ json: bad }));
  await page.goto("/en/app");
  await page.getByText("Explore Skills", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Featured Skills", exact: true });
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.locator("ol > li")).toHaveCount(0);
  await expect(panel.locator('a[href*="evil.test"]')).toHaveCount(0);
});
