import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { Client } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
const base = "http://127.0.0.1:3108";
const fixed = "创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画";
const html = `<!doctype html><style>body{margin:0;background:#f6eee0}svg{width:100vw;height:100vh}circle{animation:ride 3s linear infinite}@keyframes ride{to{transform:translateX(650px)}}</style><svg viewBox="0 0 960 640"><circle cx="40" cy="320" r="25" fill="#ca5735"/></svg>`;
async function database<T>(work: (client: Client) => Promise<T>) {
  const url = new URL(process.env.PROMPTMASTER_PELICAN_E2E_DB!);
  if (!/^\/pm_pelican_e2e_[a-f0-9]{16}$/.test(url.pathname))
    throw Error("DISPOSABLE_DATABASE_REQUIRED");
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
async function account(role: "USER" | "ADMIN") {
  const id = `usr_${randomUUID()}`,
    token = randomBytes(32).toString("hex");
  await database(async (c) => {
    await c.query("INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,$2,$3)", [
      id,
      `email:${id}@example.test`,
      role,
    ]);
    await c.query(
      `INSERT INTO ${role === "ADMIN" ? "administrator_users" : "regular_users"}(user_id,email,password_hash) VALUES($1,$2,'scrypt$synthetic-unused')`,
      [id, `${id}@example.test`],
    );
    await c.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash("sha256").update(token).digest("hex"), id],
    );
  });
  return { id, token };
}
async function signIn(context: BrowserContext, token: string) {
  await context.addCookies([
    {
      name: "pm_session",
      value: token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
async function api(request: APIRequestContext, path: string, method = "GET", data?: unknown) {
  return request.fetch(base + path, {
    method,
    headers: { Origin: base },
    ...(data === undefined ? {} : { data }),
  });
}
async function seed(owner: string) {
  const batch = `pelican_${randomUUID()}`,
    sample = `pelican_sample_${randomUUID()}`,
    failure = `pelican_sample_${randomUUID()}`;
  await database(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(
        "INSERT INTO pelican_batches(id,owner_user_id,request_key,identity_sha256,title,challenge_version,prompt_text,status) VALUES($1,$2,$3,$4,'Synthetic isolated verification','pelican-svg-v1',$5,'COMPLETE')",
        [batch, owner, randomUUID(), "a".repeat(64), fixed],
      );
      const config = {
        mode: "LIVE",
        provider: "deepseek",
        model: "deepseek-flash",
        productVersion: "Synthetic isolated model",
        strength: "off",
        maxOutputTokens: 512,
        reasoningTokenReserve: 0,
        timeoutMs: 60000,
      };
      const payload = {
        model: config.model,
        messages: [{ role: "user", content: fixed }],
        max_tokens: 512,
        temperature: 0.2,
        stream: false,
        thinking: { type: "disabled" },
      };
      for (const [index, id] of [failure, sample].entries()) {
        const execution = `mex_${randomUUID()}`;
        if (index === 0)
          await c.query(
            "INSERT INTO model_executions(id,owner_user_id,purpose,status,provider,requested_model,product_version,input_sha256,error_code,error_message,completed_at) VALUES($1,$2,'PELICAN_TEST','FAILED','deepseek','deepseek-flash','Synthetic isolated model',$3,'SYNTHETIC_NO_DISPATCH','Synthetic fixture only',now())",
            [execution, owner, "a".repeat(64)],
          );
        else
          await c.query(
            "INSERT INTO model_executions(id,owner_user_id,purpose,status,provider,requested_model,product_version,input_sha256,output_text,prompt_tokens,completion_tokens,total_tokens,latency_ms,completed_at,quota_reservation_status,reconciliation_status,pricing_snapshot_id,quota_usage_day,reserved_total_tokens,estimated_cost_usd,per_attempt_tokens,per_attempt_cost_usd,max_attempts) VALUES($1,$2,'PELICAN_TEST','SUCCEEDED','deepseek','deepseek-flash','Synthetic isolated model',$3,$4,40,80,120,1000,now(),'SETTLED','PENDING_PROVIDER','mps_deepseek_flash_1017_peak_20261105',current_date,512,0,512,0,1)",
            [execution, owner, "b".repeat(64), html],
          );
        await c.query(
          "INSERT INTO pelican_samples(id,batch_id,ordinal,model_key,model_name,config_snapshot,request_payload,execution_id,raw_output,preview_html,preview_status,preview_reason,adapter_version,thumbnail,rerun_of,rerun_request_key) VALUES($1,$2,$3,'deepseek-direct','Synthetic isolated model',$4,$5,$6,$7,$8,$9,$10,'synthetic-test-only',$11,$12,$13)",
          [
            id,
            batch,
            index + 1,
            JSON.stringify(config),
            JSON.stringify(payload),
            execution,
            index ? html : null,
            index ? html : null,
            index ? "READY" : "INVALID",
            index ? null : "SYNTHETIC_NO_DISPATCH",
            index
              ? Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eAAAAABJRU5ErkJggg==",
                  "base64",
                )
              : null,
            index ? failure : null,
            index ? randomUUID() : null,
          ],
        );
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
  });
  return { batch, sample, failure };
}
test.describe("isolated live pelican publication and preview", () => {
  test.skip(
    !process.env.PROMPTMASTER_PELICAN_E2E_DB,
    "Run npm run test:pelican:e2e using a disposable DB.",
  );
  test("real HTTP permissions, failed record cleanup, desktop playback and withdrawal", async ({
    browser,
  }) => {
    const admin = await account("ADMIN"),
      user = await account("USER"),
      fixture = await seed(admin.id),
      cleanupFixture = await seed(admin.id);
    const guest = await browser.newContext({
        baseURL: base,
        viewport: { width: 1440, height: 1000 },
      }),
      manager = await browser.newContext({ baseURL: base }),
      member = await browser.newContext({ baseURL: base });
    const errors: string[] = [];
    for (const context of [guest, manager, member])
      context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
    try {
      await signIn(manager, admin.token);
      await signIn(member, user.token);
      for (const context of [guest, member]) {
        const status = context === guest ? 401 : 403;
        expect((await api(context.request, "/api/pelican/admin")).status()).toBe(status);
        expect(
          (
            await api(context.request, `/api/pelican/admin/samples/${fixture.sample}/evidence`)
          ).status(),
        ).toBe(status);
        for (const action of [
          { action: "run", confirmed: true, budgetFingerprint: "a".repeat(64) },
          { action: "publish" },
          { action: "withdraw", reason: "forbidden" },
          { action: "rerun", sampleId: fixture.sample, requestKey: randomUUID(), confirmed: true },
          { action: "stop", sampleId: fixture.sample, confirmed: true },
          { action: "delete-failed", sampleId: fixture.failure, confirmed: true },
        ])
          expect(
            (
              await api(context.request, `/api/pelican/admin/${fixture.batch}`, "POST", action)
            ).status(),
          ).toBe(status);
        expect(
          (await api(context.request, `/api/pelican/samples/${fixture.sample}/thumbnail`)).status(),
        ).toBe(404);
        expect(
          (
            await api(context.request, "/api/pelican/preview", "POST", { sampleId: fixture.sample })
          ).status(),
        ).toBe(404);
      }
      expect((await api(guest.request, "/api/pelican?page=1&modelKey=&batchId=")).ok()).toBe(true);
      expect((await (await api(guest.request, "/api/pelican")).json()).batches).toEqual([]);
      const before = await database(
        async (c) => (await c.query("SELECT count(*) FROM model_executions")).rows[0].count,
      );
      expect(
        (
          await api(manager.request, `/api/pelican/admin/${cleanupFixture.batch}`, "POST", {
            action: "delete-failed",
            sampleId: cleanupFixture.failure,
            confirmed: true,
          })
        ).ok(),
      ).toBe(true);
      const cleaned = await (
        await api(manager.request, `/api/pelican/admin/${cleanupFixture.batch}`)
      ).json();
      expect(cleaned.batch.samples.map((s: { id: string }) => s.id)).toEqual([
        cleanupFixture.sample,
      ]);
      expect(
        (
          await api(manager.request, `/api/pelican/admin/${cleanupFixture.batch}`, "POST", {
            action: "delete-failed",
            sampleId: cleanupFixture.sample,
            confirmed: true,
          })
        ).status(),
      ).toBe(409);
      expect(
        (
          await api(manager.request, `/api/pelican/admin/${cleanupFixture.batch}`, "POST", {
            action: "stop",
            sampleId: fixture.sample,
            confirmed: true,
          })
        ).status(),
      ).toBe(404);
      const adminPage = await manager.newPage();
      await adminPage.goto("/zh-CN/pelican/manage");
      await expect(
        adminPage.getByRole("heading", { name: "管理鹈鹕测试", exact: true }),
      ).toBeVisible();
      expect(
        (
          await api(manager.request, `/api/pelican/admin/${fixture.batch}`, "POST", {
            action: "publish",
          })
        ).ok(),
      ).toBe(true);
      const listing = await (
        await api(guest.request, "/api/pelican?page=1&modelKey=&batchId=")
      ).json();
      expect(listing.batches[0].samples).toHaveLength(2);
      expect(listing.batches[0].samples.map((s: { callStatus: string }) => s.callStatus)).toEqual([
        "FAILED",
        "SUCCEEDED",
      ]);
      for (const secret of [
        admin.id,
        "raw_output",
        "request_payload",
        "execution_id",
        "synthetic-test-only",
        "<svg",
        "provider_request_id",
      ])
        expect(JSON.stringify(listing)).not.toContain(secret);
      const image = await api(guest.request, `/api/pelican/samples/${fixture.sample}/thumbnail`);
      expect(image.status()).toBe(200);
      expect(image.headers()["cache-control"]).toBe("no-store");
      const evidence = await api(
        manager.request,
        `/api/pelican/admin/samples/${fixture.sample}/evidence`,
      );
      expect(evidence.ok()).toBe(true);
      expect((await evidence.json()).evidence.requestPayload.messages).toEqual([
        { role: "user", content: fixed },
      ]);
      const opened = await api(guest.request, "/api/pelican/preview", "POST", {
        sampleId: fixture.sample,
      });
      expect(opened.status()).toBe(201);
      const { sessionId } = await opened.json();
      const path = `/api/pelican/preview/${sessionId}`;
      const a = await (await api(guest.request, path)).body();
      expect((await api(guest.request, path, "POST", { action: "pause" })).ok()).toBe(true);
      const b = await (await api(guest.request, path)).body();
      expect(b.equals(a)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect((await (await api(guest.request, path)).body()).equals(b)).toBe(true);
      expect((await api(guest.request, path, "POST", { action: "resume" })).ok()).toBe(true);
      expect((await (await api(guest.request, path)).body()).equals(b)).toBe(false);
      const page = await guest.newPage();
      await page.goto("/zh-CN/pelican");
      await expect(page.getByRole("heading", { name: "一只鹈鹕，一辆自行车。" })).toBeVisible();
      const card = page.getByRole("button", { name: /打开作品：Synthetic isolated model/ }).last();
      await card.click();
      await expect(page.getByRole("img", { name: "作品真实动画画面" })).toBeVisible();
      await page.getByRole("button", { name: "暂停骑行", exact: true }).click();
      await expect(page.getByRole("button", { name: "继续骑行", exact: true })).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("pelican-desktop-paused.png"),
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(card).toBeFocused();
      await page.getByRole("button", { name: "模型历史", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Synthetic isolated model", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const withdrawn = await api(manager.request, `/api/pelican/admin/${fixture.batch}`, "POST", {
        action: "withdraw",
        reason: "Synthetic isolated withdrawal",
      });
      expect(withdrawn.ok()).toBe(true);
      for (const url of [`/api/pelican/samples/${fixture.sample}/thumbnail`, path])
        expect([404, 410]).toContain((await api(guest.request, url)).status());
      expect(
        (
          await api(guest.request, "/api/pelican/preview", "POST", { sampleId: fixture.sample })
        ).status(),
      ).toBe(404);
      expect(
        (await (await api(guest.request, "/api/pelican?modelKey=deepseek-direct")).json()).batches,
      ).toEqual([]);
      await page.reload();
      await expect(page.getByRole("heading", { name: "还没有已发布作品" })).toBeVisible();
      expect(
        await database(
          async (c) => (await c.query("SELECT count(*) FROM model_executions")).rows[0].count,
        ),
      ).toBe(before);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all([guest.close(), manager.close(), member.close()]);
    }
  });
});
