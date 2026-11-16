import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { accountContext, type Actor } from "../identity-context";
import { createAccountInTransaction } from "../accounts";
import { ensureDatabaseReady, getPool, withTransaction } from "../db";
import { PELICAN_PROMPT } from "@/lib/pelican-types";
import {
  createPelicanBatch,
  getPelicanAdminBatch,
  getPelicanAdminData,
  getPelicanAccessibleSample,
  listPelicanPublic,
  publishPelicanBatch,
  withdrawPelicanBatch,
  rerunPelicanSample,
  deleteFailedPelicanSample,
} from "./data";

describe.skipIf(process.env.PROMPTMASTER_PELICAN_DB_TEST !== "true")(
  "Pelican data boundaries (disposable database, no supplier calls)",
  () => {
    let admin: Actor;
    let user: Actor;
    const run = <T>(who: Actor | null, work: () => Promise<T>) => accountContext.run(who, work);
    const input = (overrides = {}) => ({
      requestKey: randomUUID(),
      title: "Synthetic isolated batch",
      selections: [{ modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 128 }],
      ...overrides,
    });
    beforeEach(async () => {
      expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(
        /^\/pm_pelican_test_[a-f0-9]{16}$/,
      );
      await ensureDatabaseReady();
      await getPool().query(
        "UPDATE billing_runtime_policy SET daily_usd=1000,period_usd=1000 WHERE id=true",
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw Error("Supplier network forbidden");
        }),
      );
      await withTransaction(async (c) => {
        admin = await createAccountInTransaction(
          c,
          `pelican-admin-${randomUUID()}@example.test`,
          "scrypt$synthetic-unused",
          "ADMIN",
        );
        await c.query(
          "INSERT INTO model_quota_policies(owner_user_id,daily_token_limit,daily_cost_limit_usd,unlimited) VALUES($1,200000,1,true) ON CONFLICT(owner_user_id) DO UPDATE SET unlimited=true",
          [admin.id],
        );
        user = await createAccountInTransaction(
          c,
          `pelican-user-${randomUUID()}@example.test`,
          "scrypt$synthetic-unused",
          "USER",
        );
      });
    });
    afterAll(async () => {
      vi.unstubAllGlobals();
      await getPool().end();
    });
    async function failKnown(sampleId: string) {
      await withTransaction(async (c) => {
        const id = `mex_${randomUUID()}`;
        await c.query(
          `INSERT INTO model_executions(id,owner_user_id,purpose,status,provider,requested_model,product_version,input_sha256,error_code,error_message,completed_at) VALUES($1,$2,'PELICAN_TEST','FAILED','deepseek','deepseek-flash','DeepSeek-V4.1-Flash-1017',$3,'SYNTHETIC_ZERO_ATTEMPTS','Synthetic failure; no supplier call',now())`,
          [id, admin.id, "a".repeat(64)],
        );
        await c.query(
          `UPDATE pelican_samples SET execution_id=$2,raw_output='synthetic private raw',preview_html='synthetic private html',preview_status='INVALID',preview_reason='Synthetic zero-attempt failure',adapter_version='synthetic-v1' WHERE id=$1`,
          [sampleId, id],
        );
        await c.query(
          `UPDATE pelican_batches SET status='COMPLETE' WHERE id=(SELECT batch_id FROM pelican_samples WHERE id=$1)`,
          [sampleId],
        );
      });
    }
    it("requires active real administrator identity for every management operation", async () => {
      await expect(run(null, () => createPelicanBatch(input()))).rejects.toMatchObject({
        status: 401,
      });
      await expect(run(user, () => createPelicanBatch(input()))).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        run({ ...user, role: "ADMIN" }, () => getPelicanAdminData()),
      ).rejects.toMatchObject({ status: 403 });
      await getPool().query("UPDATE administrator_users SET disabled=true WHERE user_id=$1", [
        admin.id,
      ]);
      await expect(run(admin, () => getPelicanAdminData())).rejects.toMatchObject({ status: 403 });
    });
    it("soft hides only owned failed records and retains immutable evidence and exact recovery", async () => {
      const body = input({ title: "Synthetic audited deletion" });
      const batch = await run(admin, () => createPelicanBatch(body));
      const id = batch.samples[0].id;
      await expect(run(admin, () => deleteFailedPelicanSample(batch.id, id))).rejects.toMatchObject(
        { status: 409 },
      );
      await expect(run(user, () => deleteFailedPelicanSample(batch.id, id))).rejects.toMatchObject({
        status: 403,
      });
      await failKnown(id);
      const other = await withTransaction((c) =>
        createAccountInTransaction(
          c,
          `pelican-other-${randomUUID()}@example.test`,
          "scrypt$synthetic-unused",
          "ADMIN",
        ),
      );
      await expect(run(other, () => deleteFailedPelicanSample(batch.id, id))).rejects.toMatchObject(
        { status: 404 },
      );
      const before = (await getPool().query("SELECT * FROM pelican_samples WHERE id=$1", [id]))
        .rows[0];
      await run(admin, () => deleteFailedPelicanSample(batch.id, id));
      await run(admin, () => deleteFailedPelicanSample(batch.id, id));
      expect(
        (await getPool().query("SELECT * FROM pelican_samples WHERE id=$1", [id])).rows[0],
      ).toEqual(before);
      expect(
        (await getPool().query("SELECT * FROM pelican_sample_deletions WHERE sample_id=$1", [id]))
          .rowCount,
      ).toBe(1);
      await expect(
        getPool().query("DELETE FROM pelican_sample_deletions WHERE sample_id=$1", [id]),
      ).rejects.toMatchObject({ code: "23514" });
      expect(
        (
          await run(admin, () => getPelicanAdminData({ query: "Synthetic audited deletion" }))
        ).batches.some((b) => b.id === batch.id),
      ).toBe(false);
      const recovered = await run(admin, () =>
        getPelicanAdminData({ requestKey: body.requestKey, query: "unrelated", status: "running" }),
      );
      expect(recovered.batches.map((b) => b.id)).toEqual([batch.id]);
      expect(recovered.batches[0].samples).toEqual([]);
    });
    it("protects published and withdrawn failed evidence from soft deletion", async () => {
      const batch = await run(admin, () => createPelicanBatch(input()));
      await failKnown(batch.samples[0].id);
      await run(admin, () => publishPelicanBatch(batch.id));
      await expect(
        run(admin, () => deleteFailedPelicanSample(batch.id, batch.samples[0].id)),
      ).rejects.toMatchObject({ status: 409 });
      await run(admin, () => withdrawPelicanBatch(batch.id, "Synthetic deletion protection"));
      await expect(
        run(admin, () => deleteFailedPelicanSample(batch.id, batch.samples[0].id)),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("intersects model and status on the same sample and bounds filter input", async () => {
      const body = input({
        title: "Synthetic intersection",
        selections: [
          { modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 128 },
          { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off", maxOutputTokens: 128 },
        ],
      });
      const batch = await run(admin, () => createPelicanBatch(body));
      await failKnown(batch.samples[0].id);
      expect(
        (
          await run(admin, () =>
            getPelicanAdminData({
              query: "Synthetic intersection",
              modelKey: "deepseek-direct",
              status: "queued",
            }),
          )
        ).batches,
      ).toEqual([]);
      const matched = await run(admin, () =>
        getPelicanAdminData({
          query: "Synthetic intersection",
          modelKey: "deepseek-ai/DeepSeek-V4-Pro",
          status: "queued",
        }),
      );
      expect(matched.batches.map((b) => b.id)).toEqual([batch.id]);
      expect(matched.batches[0].samples.map((s) => s.id)).toEqual([batch.samples[1].id]);
      await expect(
        run(admin, () => getPelicanAdminData({ query: "x".repeat(121) })),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        run(admin, () => getPelicanAdminData({ status: "unexpected" })),
      ).rejects.toMatchObject({ status: 400 });
    });
    it("allocates rerun ordinals after hidden evidence without reusing its identity", async () => {
      const batch = await run(admin, () =>
        createPelicanBatch(
          input({
            selections: [
              { modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 128 },
              { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off", maxOutputTokens: 128 },
            ],
          }),
        ),
      );
      await failKnown(batch.samples[0].id);
      await failKnown(batch.samples[1].id);
      await run(admin, () => deleteFailedPelicanSample(batch.id, batch.samples[1].id));
      await expect(
        run(admin, () => rerunPelicanSample(batch.id, batch.samples[1].id, randomUUID())),
      ).rejects.toMatchObject({ status: 409 });
      const rerun = await run(admin, () =>
        rerunPelicanSample(batch.id, batch.samples[0].id, randomUUID()),
      );
      expect(rerun.samples).toHaveLength(2);
      expect(
        (
          await getPool().query(
            "SELECT ordinal FROM pelican_samples WHERE batch_id=$1 ORDER BY ordinal",
            [batch.id],
          )
        ).rows.map((r) => r.ordinal),
      ).toEqual([1, 2, 3]);
      expect(rerun.samples[1].rerunOf).toBe(batch.samples[0].id);
    });
    it("creates immutable prompt/config snapshots with idempotent request identity and no key or dispatch", async () => {
      const body = input();
      const batch = await run(admin, () => createPelicanBatch(body));
      expect((await run(admin, () => createPelicanBatch(body))).id).toBe(batch.id);
      await expect(
        run(admin, () => createPelicanBatch({ ...body, title: "Changed intent" })),
      ).rejects.toMatchObject({ status: 409 });
      const row = (
        await getPool().query(
          "SELECT s.*,b.prompt_text FROM pelican_samples s JOIN pelican_batches b ON b.id=s.batch_id WHERE s.id=$1",
          [batch.samples[0].id],
        )
      ).rows[0];
      expect(row.prompt_text).toBe(PELICAN_PROMPT);
      expect(row.request_payload.messages).toEqual([
        { role: "system", content: expect.any(String) },
        { role: "user", content: PELICAN_PROMPT },
      ]);
      expect(row.config_snapshot.maxRetries).toBe(0);
      expect(JSON.stringify(row)).not.toContain("unused-no-network");
      expect(row.config_snapshot).not.toHaveProperty("apiKey");
      expect(row.execution_id).toBeNull();
      expect(batch.samples[0].modelName).toBe("DeepSeek-V4.1-Flash-1017");
      expect(batch.canRun).toBe(true);
      expect(batch.estimatedTokens).toBeGreaterThan(128);
      expect(batch.budgetFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(fetch).not.toHaveBeenCalled();
    });
    it("publishes every terminal result through an explicit whitelist and withdraws all public access", async () => {
      const batch = await run(admin, () => createPelicanBatch(input()));
      const id = batch.samples[0].id;
      await expect(run(null, () => getPelicanAccessibleSample(id))).rejects.toMatchObject({
        status: 404,
      });
      expect(
        (await run(null, () => listPelicanPublic(new URLSearchParams(`batchId=${batch.id}`))))
          .batches,
      ).toEqual([]);
      await expect(run(admin, () => publishPelicanBatch(batch.id))).rejects.toMatchObject({
        status: 409,
      });
      await failKnown(id);
      await run(admin, () => publishPelicanBatch(batch.id));
      const listing = await run(null, () =>
        listPelicanPublic(new URLSearchParams(`batchId=${batch.id}`)),
      );
      expect(listing.batches[0].samples).toHaveLength(1);
      expect(listing.batches[0].samples[0].callStatus).toBe("FAILED");
      const gallery = await run(null, () =>
        listPelicanPublic(new URLSearchParams("page=1&modelKey=&batchId=")),
      );
      expect(gallery.batches.map((b) => b.id)).toContain(batch.id);
      const text = JSON.stringify(listing);
      for (const secret of [
        admin.id,
        "synthetic private raw",
        "synthetic private html",
        "request_key",
        "execution_id",
        "config_snapshot",
        "estimatedCostUsd",
      ])
        expect(text).not.toContain(secret);
      expect((await run(null, () => getPelicanAccessibleSample(id))).id).toBe(id);
      await run(admin, () => withdrawPelicanBatch(batch.id, "Synthetic withdrawal"));
      expect(
        (
          await run(null, () => listPelicanPublic(new URLSearchParams(`modelKey=deepseek-direct`)))
        ).batches.find((b) => b.id === batch.id),
      ).toBeUndefined();
      await expect(run(null, () => getPelicanAccessibleSample(id))).rejects.toMatchObject({
        status: 404,
      });
      await expect(run(admin, () => publishPelicanBatch(batch.id))).rejects.toMatchObject({
        status: 409,
      });
      expect(fetch).not.toHaveBeenCalled();
    });
    it("appends idempotent reruns without overwriting original evidence or publishing queued samples", async () => {
      const batch = await run(admin, () => createPelicanBatch(input()));
      const original = batch.samples[0].id;
      await failKnown(original);
      const requestKey = randomUUID();
      const rerun = await run(admin, () => rerunPelicanSample(batch.id, original, requestKey));
      expect(rerun.samples).toHaveLength(2);
      expect(rerun.samples[1].rerunOf).toBe(original);
      expect(
        (await run(admin, () => rerunPelicanSample(batch.id, original, requestKey))).samples,
      ).toHaveLength(2);
      expect(
        (await run(admin, () => getPelicanAdminData({ rerunRequestKey: requestKey }))).batches.map(
          (b) => b.id,
        ),
      ).toEqual([batch.id]);
      expect(
        (await run(admin, () => getPelicanAdminData({ rerunRequestKey: randomUUID() }))).batches,
      ).toEqual([]);
      expect(rerun.samples[0].callStatus).toBe("FAILED");
      expect(rerun.samples[1].callStatus).toBe("QUEUED");
      await expect(run(admin, () => publishPelicanBatch(batch.id))).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        getPool().query("UPDATE pelican_samples SET raw_output='rewritten' WHERE id=$1", [
          original,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        getPool().query("UPDATE pelican_samples SET model_name='renamed' WHERE id=$1", [original]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        getPool().query("UPDATE pelican_samples SET preview_html='rewritten' WHERE id=$1", [
          original,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        getPool().query("DELETE FROM pelican_samples WHERE id=$1", [original]),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("quotes the whole queued batch against one daily budget", async () => {
      const batch = await run(admin, () =>
        createPelicanBatch(
          input({
            selections: [
              { modelKey: "deepseek-direct", strength: "off", maxOutputTokens: 512 },
              { modelKey: "deepseek-ai/DeepSeek-V4-Pro", strength: "off", maxOutputTokens: 512 },
            ],
          }),
        ),
      );
      const limit = Math.floor(batch.estimatedTokens / 2) + 1;
      await getPool().query(
        "UPDATE model_quota_policies SET unlimited=false,daily_token_limit=$2 WHERE owner_user_id=$1",
        [admin.id, limit],
      );
      const blocked = await run(admin, () => getPelicanAdminBatch(batch.id));
      expect(blocked.canRun).toBe(false);
      expect(blocked.blockedReason).toBe("MODEL_QUOTA_EXCEEDED");
      expect(blocked.runBlock).toMatchObject({
        code: "MODEL_QUOTA_EXCEEDED",
        scope: "period",
        requiredTokens: batch.estimatedTokens,
        remainingTokens: 300000,
      });
      await getPool().query(
        "UPDATE model_quota_policies SET unlimited=true WHERE owner_user_id=$1",
        [admin.id],
      );
      const allowed = await run(admin, () => getPelicanAdminBatch(batch.id));
      expect(allowed.canRun).toBe(true);
      expect(allowed.runBlock).toBeNull();
    });
    it("blocks queued dispatch when effective model config changes or aggregate budget is unavailable", async () => {
      const batch = await run(admin, () => createPelicanBatch(input()));
      await getPool().query(
        "UPDATE model_quota_policies SET unlimited=false,daily_cost_limit_usd=0 WHERE owner_user_id=$1",
        [admin.id],
      );
      expect((await run(admin, () => getPelicanAdminBatch(batch.id))).canRun).toBe(false);
      vi.stubEnv("DEEPSEEK_PRODUCT_VERSION", "synthetic-changed-product");
      try {
        expect((await run(admin, () => getPelicanAdminBatch(batch.id))).canRun).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
      expect(fetch).not.toHaveBeenCalled();
    });
  },
);
