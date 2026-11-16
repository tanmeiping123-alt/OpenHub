import { randomUUID, createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Client } from "pg";
import { test, expect } from "./fixtures";
import { cleanupE2ePrompt } from "./db-cleanup";
import { createTestAccount, cleanupTestAccount, testDatabase } from "../scripts/test-account.mjs";

const origin = "http://127.0.0.1:3000";
async function signIn(page: Page, email: string, password: string, next = "/en/app") {
  await page.context().clearCookies();
  await page.goto(`/en/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(origin + next);
}

test("anonymous deep links redirect before rendering and all legacy business entries reject access", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.unroute("**/api/demo/snapshot");
  for (const path of [
    "/en/app",
    "/zh-CN/app/generate",
    "/en/app/prompts/anything/edit",
    "/en/app/settings",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/(en|zh-CN)\/login\?/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    await expect(page.locator(".sidebar")).toHaveCount(0);
  }
  const paths = [
    "/api/demo/snapshot",
    "/api/ai/quota",
    "/api/skills",
    "/api/skills/library",
    "/api/skills/featured",
    "/api/accounts",
  ];
  for (const path of paths) {
    const response = await context.request.get(path);
    expect(response.status(), path).toBe(401);
  }
  for (const path of [
    "/api/prompts",
    "/api/ai/generate",
    "/api/ai/optimize",
    "/api/ai/playground",
    "/api/ai/evaluation-advice",
  ]) {
    expect(
      (await context.request.post(path, { headers: { origin }, data: {} })).status(),
      path,
    ).toBe(401);
  }
});

test("real login returns to the intended workspace query, never Settings by default", async ({
  page,
  testAccount,
}) => {
  await page.unroute("**/api/demo/snapshot");
  await signIn(page, testAccount.email, testAccount.password, "/en/app/generate?from=login");
  await expect(page.getByRole("heading", { name: "Prompt Generator", exact: true })).toBeVisible();
  await page.goto("/en/login");
  await expect(page).toHaveURL(origin + "/en/app");
  await expect(
    page.getByRole("heading", { name: /A clear thought\.\s*A better Prompt\./ }),
  ).toBeVisible();
});

test("wrong password remains on login with a focused recoverable error", async ({
  page,
  context,
  testAccount,
}) => {
  await context.clearCookies();
  await page.goto("/en/login");
  await page.getByLabel("Email", { exact: true }).fill(testAccount.email);
  await page.getByLabel("Password", { exact: true }).fill("incorrect-test-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.locator(".auth-error")).toContainText("Check your email and password");
  await expect(page.locator(".auth-error")).toBeFocused();
  await expect(page).toHaveURL(origin + "/en/login");
  expect((await context.request.get("/api/demo/snapshot")).status()).toBe(401);
});

test("registration links preserve destination and external next cannot redirect off site", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/en/app/generate?mode=professional");
  await expect(page).toHaveURL(/\/en\/login\?/);
  await page.locator(".auth-switch").getByRole("link", { name: "Create account" }).click();
  expect(new URL(page.url()).searchParams.get("next")).toBe("/en/app/generate?mode=professional");
  await page.goto("/en/login?next=https%3A%2F%2Fevil.test");
  const href = await page.locator(".auth-switch a").getAttribute("href");
  expect(new URL(href!, origin).searchParams.get("next")).toBe("/en/app");
});

test("logout revokes the server token, locks other tabs and prevents return-key access", async ({
  page,
  context,
  testAccount,
}) => {
  await signIn(page, testAccount.email, testAccount.password);
  const oldToken = (await context.cookies()).find((c) => c.name === "pm_session")!.value;
  const other = await context.newPage();
  await other.goto("/en/app/settings");
  await expect(
    other.getByRole("banner").getByRole("button", { name: "Log out", exact: true }),
  ).toBeVisible();
  await page.goto("/en/app/generate");
  await page.getByRole("banner").getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/login\?reason=logged-out/);
  await expect(other).toHaveURL(/\/en\/login\?/);
  expect(
    (
      await context.request.get("/api/demo/snapshot", {
        headers: { cookie: `pm_session=${oldToken}` },
      })
    ).status(),
  ).toBe(401);
  await page.goBack();
  await expect(page).toHaveURL(/\/en\/login/);
  await expect(page.locator(".sidebar")).toHaveCount(0);
});

test("malformed, unknown and expired cookies cannot authenticate server-rendered pages", async ({
  page,
  context,
}) => {
  const account = await createTestAccount();
  try {
    for (const token of ["invalid", "f".repeat(64), account.token]) {
      if (token === account.token)
        await testDatabase((c: Client) =>
          c.query(
            "UPDATE account_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1 AND user_id=$2",
            [createHash("sha256").update(token).digest("hex"), account.id],
          ),
        );
      await context.clearCookies();
      await context.addCookies([{ name: "pm_session", value: token, url: origin }]);
      await page.goto("/en/app");
      await expect(page).toHaveURL(/\/en\/login\?.*reason=expired/);
      await expect(page.getByText(/Your session expired/)).toBeVisible();
      expect((await context.request.get("/api/demo/snapshot")).status()).toBe(401);
    }
  } finally {
    await cleanupTestAccount(account);
  }
});

test("session service failure locks an open workspace and retry recovers without a guest fallback", async ({
  page,
}) => {
  await page.goto("/en/app/settings");
  await expect(
    page.getByRole("banner").getByRole("button", { name: "Log out", exact: true }),
  ).toBeVisible();
  await page.route("**/api/auth/session", (r) =>
    r.fulfill({ status: 503, json: { error: "ACCOUNT_SERVICE_UNAVAILABLE" } }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("Session verification unavailable. Workspace is locked."),
  ).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.unroute("**/api/auth/session");
  await page.getByRole("button", { name: "Retry verification" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
});

test("valid credentials recover from duplicate old cookies and logout clears them safely", async ({
  request,
  testAccount,
}) => {
  const headers = { origin, cookie: "pm_session=invalid; pm_session=duplicate" };
  const response = await request.post("/api/auth/login", {
    headers,
    data: { email: testAccount.email, password: testAccount.password },
  });
  expect(response.status()).toBe(200);
  const logout = await request.post("/api/auth/logout", { headers });
  expect(logout.status()).toBe(200);
  expect(logout.headers()["set-cookie"]).toContain("Max-Age=0");
});

test("client navigation from a public page restores only the signed-in workspace", async ({
  page,
  request,
}) => {
  await page.unroute("**/api/demo/snapshot");
  const title = `E2E test: ${randomUUID()}`;
  const created = await request.post("/api/prompts", {
    headers: { origin },
    data: { title, taskType: "General", content: "Synthetic public-to-private navigation source." },
  });
  expect(created.status()).toBe(201);
  const { promptId } = await created.json();
  try {
    await page.goto("/en");
    await page.getByRole("link", { name: "Create a Prompt", exact: true }).click();
    await expect(page).toHaveURL(origin + "/en/app/generate");
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.locator(`a[href="/en/app/prompts/${promptId}/edit"]`).first()).toBeVisible();
  } finally {
    await cleanupE2ePrompt(promptId, title);
  }
});

test("favorites and library bind the signed-in owner, never headers or the legacy demo", async ({
  request,
}) => {
  const title = `E2E test: ${randomUUID()}`;
  const created = await request.post("/api/prompts", {
    headers: { origin },
    data: { title, taskType: "General", content: "Synthetic owner isolation fixture." },
  });
  expect(created.status()).toBe(201);
  const { promptId } = await created.json();
  const other = await createTestAccount();
  try {
    for (const kind of ["favorites", "library"]) {
      const path = `/api/${kind}/${promptId}`;
      for (const method of ["PUT", "DELETE"]) {
        const denied = await request.fetch(path, {
          method,
          headers: {
            origin,
            cookie: `pm_session=${other.token}`,
            "x-owner-id": "usr_local_demo_01",
          },
        });
        expect(denied.status()).toBe(404);
        const allowed = await request.fetch(path, { method, headers: { origin } });
        expect(allowed.ok()).toBe(true);
      }
    }
  } finally {
    await cleanupE2ePrompt(promptId, title);
    await cleanupTestAccount(other);
  }
});

for (const locale of ["en", "zh-CN"]) {
  test(`${locale} login/register remain usable on narrow, landscape and enlarged text`, async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const size of [
      { width: 375, height: 812 },
      { width: 812, height: 375 },
    ]) {
      await page.setViewportSize(size);
      for (const action of ["login", "register"]) {
        await page.goto(`/${locale}/${action}`);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "20px";
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        const password = page.locator("#password");
        await password.fill("synthetic-password");
        await page
          .getByRole("button", { name: locale === "en" ? "Show password" : "显示密码" })
          .click();
        await expect(password).toHaveAttribute("type", "text");
        await expect(password).toHaveAttribute(
          "autocomplete",
          action === "login" ? "current-password" : "new-password",
        );
      }
    }
  });
}

test("a changed cookie identity reloads the workspace even without a storage event", async ({
  page,
  context,
  request,
}) => {
  await page.unroute("**/api/demo/snapshot");
  const title = `E2E test: ${randomUUID()}`;
  const created = await request.post("/api/prompts", {
    headers: { origin },
    data: { title, taskType: "General", content: "Synthetic account switch fixture." },
  });
  const { promptId } = await created.json();
  const other = await createTestAccount();
  try {
    await page.goto("/en/app");
    await expect(page.locator(`a[href="/en/app/prompts/${promptId}/edit"]`).first()).toBeVisible();
    await context.addCookies([{ name: "pm_session", value: other.token, url: origin }]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("heading", { name: /A clear thought\.\s*A better Prompt\./, exact: true }),
    ).toBeVisible();
    await expect(page.locator(`a[href="/en/app/prompts/${promptId}/edit"]`)).toHaveCount(0);
    await page.getByRole("link", { name: "Account profile", exact: true }).click();
    await expect(page.locator("input[readonly]")).toHaveValue(other.email);
  } finally {
    await cleanupE2ePrompt(promptId, title);
    await cleanupTestAccount(other);
  }
});
