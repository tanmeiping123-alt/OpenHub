import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

async function roundTrip(page: Page, locale: "en" | "zh-CN") {
  const toggle = page.getByRole("button", {
    name: locale === "en" ? /^Professional mode · Current:/ : /^专家模式 · 当前：/,
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
}

for (const locale of ["en", "zh-CN"] as const) {
  test(`${locale}: mode round trips preserve input, editor draft and optimizer selection without writes`, async ({
    page,
  }) => {
    const writes: string[] = [];
    // Prevent any accidental model/business write, including when a regression occurs.
    await page.route("**/api/**", (route) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
        writes.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort();
      }
      return route.fallback();
    });
    await page.goto(`/${locale}/app/generate`);
    const goal = page.locator("#goal");
    await goal.fill("A complex task / 保留任务目标");
    await page
      .getByText(locale === "en" ? "Purposes and tags · optional" : "用途与标签 · 可选", {
        exact: true,
      })
      .click();
    const purpose = page.getByRole("checkbox", {
      name: locale === "en" ? "Develop & build" : "开发与构建",
      exact: true,
    });
    await purpose.check();
    await roundTrip(page, locale);
    await expect(goal).toHaveValue("A complex task / 保留任务目标");
    await expect(purpose).toBeChecked();
    await expect(page.locator("#classification")).toHaveCount(0);
    await page
      .getByRole("button", { name: locale === "en" ? "Adjust" : "调整", exact: true })
      .click();
    const none = page.getByRole("radio", {
      name: locale === "en" ? "Do not use Skills" : "不使用 Skills",
      exact: true,
    });
    await none.check();
    await roundTrip(page, locale);
    await expect(none).toBeChecked();
    await expect(goal).toHaveValue("A complex task / 保留任务目标");

    await page.goto(`/${locale}/app/prompts/prm_writing_course_01/edit`);
    await page.locator("#prompt-title").fill("Unsaved title / 未保存标题");
    await page.locator("#prompt-content").fill("Unsaved draft / 未保存内容");
    await roundTrip(page, locale);
    await expect(page.locator("#prompt-title")).toHaveValue("Unsaved title / 未保存标题");
    await expect(page.locator("#prompt-content")).toHaveValue("Unsaved draft / 未保存内容");

    await page.goto(`/${locale}/app/prompts/prm_writing_course_01/optimize`);
    await page.locator(".simulation-option > summary").click();
    const selection = page.locator(".simulation-option").getByRole("checkbox").first();
    await selection.check();
    const preview = page.locator(".split .panel").last();
    const proposal = await preview.innerText();
    await roundTrip(page, locale);
    await expect(selection).toBeChecked();
    expect(await preview.innerText()).toBe(proposal);
    expect(writes).toEqual([]);
  });
}

test("approved policies remain readable at narrow and landscape sizes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const size of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/zh-CN/app/settings");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    await page.locator("main").getByRole("button", { name: "专家模式", exact: true }).click();
    await expect(
      page.locator("main").getByRole("button", { name: "专家模式", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("link", { name: "打开 Skills 管理", exact: true }).click();
    const panel = page.getByRole("region", { name: "Skills 库" });
    await panel.getByText("查看依据 · 匹配规则", { exact: true }).click();
    await expect(panel.getByText(/本地匹配推荐可能适合当前任务/)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
});
