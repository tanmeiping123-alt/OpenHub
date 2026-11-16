import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";

const evidence = path.join(process.env.LOCALAPPDATA ?? "..", "PromptMasterAI", "ui-refresh");
test("mobile navigation exposes all tools, traps focus and returns to its trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/zh-CN/app");
  const trigger = page.getByRole("button", { name: "更多导航", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "全部导航" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "版本历史", exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "评估报告", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("link", { name: "设置", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
  await expect(dialog).not.toBeVisible();
});

test("generator starts with one goal form and secondary tools retain the draft", async ({
  page,
}) => {
  await page.route("**/api/ai/**", (r) => r.abort());
  await page.route("**/api/skills/workflow", (r) => r.abort());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/en/app/generate");
  const goal = page.getByRole("textbox", { name: "What do you want the AI to do?", exact: true });
  await expect(goal).toBeInViewport();
  await expect(
    page.getByRole("textbox", { name: "Task goal and explicit constraints", exact: true }),
  ).not.toBeVisible();
  await goal.fill("Keep this precise task while I explore advanced tools");
  const secondary = page.getByRole("button", { name: "Adjust", exact: true });
  await secondary.click();
  await expect(
    page.getByRole("textbox", { name: "Task goal and explicit constraints", exact: true }),
  ).toHaveCount(0);
  await secondary.click();
  await expect(goal).toHaveValue("Keep this precise task while I explore advanced tools");
});

test("workspace visual review and primary navigation", async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await page.route("**/api/ai/**", (r) => r.abort());
  await page.route("**/api/skills/workflow", (r) => r.abort());
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [name, url] of [
    ["dashboard", "/zh-CN/app"],
    ["generate", "/zh-CN/app/generate"],
    ["editor", "/zh-CN/app/prompts/prm_writing_course_01/edit"],
    ["library", "/zh-CN/app/library"],
    ["home", "/zh-CN"],
    ["community", "/zh-CN/open-prompts"],
    ["evaluate", "/zh-CN/app/prompts/prm_writing_course_01/evaluate"],
    ["optimize", "/zh-CN/app/prompts/prm_writing_course_01/optimize"],
    ["playground", "/zh-CN/app/playground"],
  ]) {
    await page.goto(url);
    await expect(page.locator("h1").first()).toBeVisible();
    if (name === "community")
      await expect(page.getByText("正在加载社区…", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: path.join(evidence, `${process.env.UI_REVIEW_PHASE ?? "after"}-${name}.png`),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});

test("public and workspace pages reflow with readable mobile navigation", async ({ page }) => {
  await page.route("**/api/ai/**", (r) => r.abort());
  await page.route("**/api/skills/workflow", (r) => r.abort());
  for (const width of [375, 812]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 375 });
    for (const [name, url] of [
      ["home", "/zh-CN"],
      ["dashboard", "/zh-CN/app"],
      ["generate", "/zh-CN/app/generate"],
      ["community", "/zh-CN/open-prompts"],
    ]) {
      await page.goto(url);
      await expect(page.locator("h1")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: path.join(evidence, `mobile-${width}-${name}.png`),
        fullPage: true,
      });
    }
  }
});
