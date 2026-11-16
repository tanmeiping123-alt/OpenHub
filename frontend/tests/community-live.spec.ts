import { test, expect, type BrowserContext, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import path from "node:path";

const base = "http://127.0.0.1:3107";
type Account = { id: string; email: string; password: string; token: string };
async function makeAccount(role: "USER" | "ADMIN"): Promise<Account> {
  const url = new URL(process.env.PROMPTMASTER_COMMUNITY_E2E_DB!);
  if (!/^\/pm_community_e2e_[a-f0-9]{16}$/.test(url.pathname))
    throw Error("DISPOSABLE_DATABASE_REQUIRED");
  const a = {
    id: `usr_${randomUUID()}`,
    email: `community-${randomUUID()}@example.test`,
    password: randomBytes(20).toString("hex"),
    token: randomBytes(32).toString("hex"),
  };
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$32768$8$3$${salt}$${scryptSync(a.password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,$2,$3)", [
      a.id,
      `email:${a.email}`,
      role,
    ]);
    await c.query(
      `INSERT INTO ${role === "ADMIN" ? "administrator_users" : "regular_users"}(user_id,email,password_hash) VALUES($1,$2,$3)`,
      [a.id, a.email, hash],
    );
    await c.query(
      "INSERT INTO user_profiles(user_id,display_name) VALUES($1,'Private account name')",
      [a.id],
    );
    await c.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '2 hours')",
      [createHash("sha256").update(a.token).digest("hex"), a.id],
    );
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
  return a;
}
async function signIn(context: BrowserContext, a: Account) {
  await context.addCookies([
    {
      name: "pm_session",
      value: a.token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function api(
  request: APIRequestContext,
  url: string,
  method = "GET",
  data?: unknown,
  key?: string,
) {
  return request.fetch(`${base}${url}`, {
    method,
    headers: { Origin: base, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(data === undefined ? {} : { data }),
  });
}
test.describe("isolated live community", () => {
  test.skip(
    !process.env.PROMPTMASTER_COMMUNITY_E2E_DB,
    "Run npm run test:community:e2e with a disposable database.",
  );
  test("real publish → Star → private copy → improve → report → governance → withdrawal stays isolated", async ({
    browser,
  }) => {
    test.setTimeout(150000);
    const [author, reader, admin] = await Promise.all([
      makeAccount("USER"),
      makeAccount("USER"),
      makeAccount("ADMIN"),
    ]);
    const authorContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      baseURL: base,
    });
    const readerContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: base,
    });
    const anonymous = await browser.newContext({
      viewport: { width: 375, height: 812 },
      baseURL: base,
    });
    const adminContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      baseURL: base,
    });
    const contexts = [authorContext, readerContext, anonymous, adminContext];
    const modelWrites: string[] = [],
      pageErrors: string[] = [];
    for (const context of contexts) {
      context.on("request", (r) => {
        if (/\/api\/(ai|skills\/workflow)/.test(r.url()) && r.method() !== "GET")
          modelWrites.push(r.url());
      });
      context.on("page", (page) => page.on("pageerror", (e) => pageErrors.push(e.message)));
    }
    try {
      await signIn(authorContext, author);
      await signIn(adminContext, admin);
      const page = await authorContext.newPage();
      const visitor = await anonymous.newPage();
      const body =
        "请帮助我解释 {{概念}}。\n\n1. 先给出一句话定义。\n2. 用生活中的类比说明。\n3. 提供一个练习，核查理解。\n\n不确定的信息请明确说明。";
      await page.goto("/zh-CN/open-prompts");
      await expect(page.getByText("第一个好想法，可以从这里开始", { exact: true })).toBeVisible();
      await page.goto("/zh-CN/open-prompts/new");
      await page.getByLabel("标题", { exact: true }).fill("把复杂概念讲给初学者听");
      await page
        .getByLabel("简短用途", { exact: true })
        .fill("用定义、生活类比与一个小练习，把陌生概念讲清楚。");
      await page.getByLabel("完整 Prompt 正文", { exact: true }).fill(body);
      if (!(await page.getByLabel("公开昵称", { exact: true }).isVisible())) {
        await page.getByText("公开昵称与简介", { exact: true }).click();
      }
      await page.getByLabel("公开昵称", { exact: true }).fill("林间");
      await page
        .getByLabel("一句话简介（选填）", { exact: true })
        .fill("分享帮助人们理解世界的提示词。");
      await page.getByText("补充使用提示", { exact: true }).click();
      await page.getByLabel("标签", { exact: true }).fill("学习, 解释, 写作");
      await page.getByLabel("变量说明", { exact: true }).fill("{{概念}}：你希望深入理解的主题。");
      await page.getByRole("button", { name: "预览发布内容" }).click();
      await expect(page.getByRole("button", { name: "确认发布", exact: true })).toBeDisabled();
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "确认发布", exact: true }).click();
      await expect(page).toHaveURL(/\/open-prompts\/pub_[a-f0-9-]+\?version=1$/);
      const publicId = new URL(page.url()).pathname.split("/").pop()!;
      await expect(page.getByRole("textbox", { name: "Prompt 正文" })).toHaveText(body);
      await expect(page.getByRole("button", { name: "你的作品" })).toBeDisabled();
      const publicResponse = await api(anonymous.request, `/api/community/${publicId}`);
      const publicData = await publicResponse.json();
      expect(JSON.stringify(publicData)).not.toContain(author.email);
      expect(JSON.stringify(publicData)).not.toContain(author.id);
      expect(publicData.version.license).toBe("CC0-1.0");
      await visitor.goto(`/zh-CN/open-prompts/${publicId}`);
      await expect(visitor.getByRole("textbox", { name: "Prompt 正文" })).toHaveText(body);
      await expect(visitor.getByRole("button", { name: "复制 Prompt", exact: true })).toBeEnabled();
      expect((await api(anonymous.request, "/api/demo/snapshot")).status()).toBe(401);

      const member = await readerContext.newPage();
      await member.goto(`/zh-CN/open-prompts/${publicId}?version=1`);
      await member.getByRole("button", { name: "为这条 Prompt Star", exact: true }).click();
      await expect(member).toHaveURL(/\/login\?/);
      await member.getByLabel("邮箱", { exact: true }).fill(reader.email);
      await member.getByLabel("密码", { exact: true }).fill(reader.password);
      await member.getByRole("button", { name: "登录", exact: true }).click();
      await expect(member).toHaveURL(new RegExp(`/open-prompts/${publicId}\\?version=1$`));
      await member.getByRole("button", { name: "为这条 Prompt Star", exact: true }).click();
      await expect(
        member.getByRole("button", { name: "已 Star · 取消", exact: true }),
      ).toBeVisible();
      const repeated = await Promise.all(
        Array.from({ length: 6 }, () =>
          api(readerContext.request, `/api/community/${publicId}/star`, "PUT", {
            active: true,
            versionNumber: 1,
          }),
        ),
      );
      for (const result of repeated) {
        expect(result.ok()).toBe(true);
        expect((await result.json()).stars).toBe(1);
      }
      await member.getByRole("button", { name: "保存到我的 Prompt", exact: true }).click();
      const editorLink = member.getByRole("link", { name: "编辑我的副本", exact: true });
      await expect(editorLink).toBeVisible();
      const privateId = (await editorLink.getAttribute("href"))!.split("/").at(-2)!;
      const snapshot = await (await api(readerContext.request, "/api/demo/snapshot")).json();
      const privateVersion = snapshot.versions.find(
        (v: { promptId: string }) => v.promptId === privateId,
      );
      expect(privateVersion.content).toBe(body);
      expect(
        (
          await api(authorContext.request, `/api/community/source?versionId=${privateVersion.id}`)
        ).status(),
      ).toBe(404);
      const improved = body + "\n最后，请用三个自测问题帮助复习。";
      const edited = await api(
        readerContext.request,
        `/api/prompts/${privateId}/versions`,
        "POST",
        {
          content: improved,
          title: "概念解释与自测",
          baseVersionId: privateVersion.id,
          source: "MANUAL_EDIT",
        },
      );
      expect(edited.ok()).toBe(true);
      await member.goto(`/zh-CN/app/prompts/${privateId}/edit`);
      await expect(member.getByLabel("Prompt 内容", { exact: true })).toHaveValue(improved);
      await expect(member.getByText("来自 Open Prompt 的独立副本", { exact: false })).toBeVisible();
      await member.getByRole("link", { name: "发布到社区", exact: true }).click();
      await expect(
        member.getByRole("textbox", { name: "完整 Prompt 正文", exact: true }),
      ).toHaveValue(improved);
      await expect(
        member.getByRole("textbox", { name: "完整 Prompt 正文", exact: true }),
      ).toHaveAttribute("readonly", "");
      await member
        .getByLabel("简短用途", { exact: true })
        .fill("在清晰解释的基础上，加入三个复习问题。");
      if (!(await member.getByLabel("公开昵称", { exact: true }).isVisible())) {
        await member.getByText("公开昵称与简介", { exact: true }).click();
      }
      await member.getByLabel("公开昵称", { exact: true }).fill("小满");
      await member.getByRole("button", { name: "预览发布内容" }).click();
      await member.getByRole("checkbox").check();
      await member.getByRole("button", { name: "确认发布", exact: true }).click();
      await expect(member).toHaveURL(/\/open-prompts\/pub_[a-f0-9-]+\?version=1$/);
      await expect(member.getByRole("heading", { name: "基于开放作品改进" })).toBeVisible();

      await page.getByRole("link", { name: "管理发布", exact: true }).click();
      await page
        .getByRole("textbox", { name: "完整 Prompt 正文", exact: true })
        .fill(body + "\n补充一个常见误区。");
      await page.getByLabel("更新说明", { exact: true }).fill("增加常见误区提示。");
      await page.getByRole("button", { name: "预览发布内容" }).click();
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "发布更新", exact: true }).click();
      await expect(page).toHaveURL(/version=2$/);
      expect(
        (await (await api(anonymous.request, `/api/community/${publicId}?version=1`)).json())
          .version.content,
      ).toBe(body);
      expect(
        (
          await (
            await api(readerContext.request, `/api/community/source?versionId=${privateVersion.id}`)
          ).json()
        ).content,
      ).toBe(body);
      await page.goto("/zh-CN/open-prompts");
      const evidence = process.env.PROMPTMASTER_COMMUNITY_EVIDENCE!;
      await expect(
        page.getByRole("link", { name: "把复杂概念讲给初学者听", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(evidence, "open-prompt-desktop.png"),
        fullPage: true,
      });
      await visitor.goto(`/zh-CN/open-prompts/${publicId}`);
      await expect(visitor.getByRole("textbox", { name: "Prompt 正文" })).toContainText(
        "补充一个常见误区",
      );
      expect(
        await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await visitor.screenshot({
        path: path.join(evidence, "open-prompt-mobile.png"),
        fullPage: true,
      });

      await member.goto(`/zh-CN/open-prompts/${publicId}`);
      await member.getByRole("button", { name: "举报问题", exact: true }).click();
      await member
        .getByLabel("补充说明", { exact: true })
        .fill("隔离测试：请检查示例内容的公开范围。");
      await member.getByRole("button", { name: "提交举报", exact: true }).click();
      await expect(
        member.getByText("已收到举报，管理员将核查处理。", { exact: true }),
      ).toBeVisible();
      expect((await api(readerContext.request, "/api/community/moderation")).status()).toBe(403);
      const moderator = await adminContext.newPage();
      await moderator.goto("/zh-CN/open-prompts/moderation");
      await expect(
        moderator.getByText("隔离测试：请检查示例内容的公开范围。", { exact: true }),
      ).toBeVisible();
      await moderator.getByRole("button", { name: "下架作品", exact: true }).click();
      await moderator
        .getByLabel("处理原因", { exact: true })
        .fill("隔离测试核查：暂时下架等待修订。");
      await moderator.getByRole("button", { name: "确认处理", exact: true }).click();
      await expect(moderator.getByText("处理决定已记录。", { exact: true })).toBeVisible();
      expect((await api(anonymous.request, `/api/community/${publicId}?version=1`)).status()).toBe(
        404,
      );
      expect((await api(anonymous.request, `/api/community/${publicId}?version=2`)).status()).toBe(
        404,
      );
      const restore = await api(
        adminContext.request,
        "/api/community/moderation",
        "POST",
        { action: "restore", publicId, reason: "隔离测试复核通过，恢复原公开状态。" },
        randomUUID(),
      );
      expect(restore.ok()).toBe(true);
      await page.goto(`/zh-CN/open-prompts/${publicId}/edit`);
      await page.getByRole("button", { name: "撤回发布…", exact: true }).click();
      await page.getByRole("button", { name: "确认撤回", exact: true }).click();
      await expect(page).toHaveURL(/\/open-prompts\/me$/);
      expect((await api(anonymous.request, `/api/community/${publicId}?version=1`)).status()).toBe(
        404,
      );
      await visitor.reload();
      await expect(
        visitor.getByText("这条 Prompt 不存在、已撤回或已下架。", { exact: true }),
      ).toBeVisible();
      expect(
        (
          await (
            await api(readerContext.request, `/api/community/source?versionId=${privateVersion.id}`)
          ).json()
        ).content,
      ).toBe(body);
      expect(modelWrites).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
});
