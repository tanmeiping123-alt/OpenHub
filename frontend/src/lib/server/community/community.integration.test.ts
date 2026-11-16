import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { ensureDatabaseReady, getPool, withTransaction } from "../db";
import { createAccountInTransaction } from "../accounts";
import type { Actor } from "../identity-context";
import { publication } from "./validation";
import {
  publish,
  update,
  withdraw,
  detail,
  ownedDetail,
  list,
  star,
  copy,
  source,
  copySource,
  moderate,
  moderation,
  report,
  viewer,
  creatorProfile,
} from "./service";

const input = {
  title: "Synthetic community prompt",
  summary: "Synthetic",
  content: "Independent public snapshot",
  taskType: "Writing",
  language: "en",
  tags: ["synthetic"],
  variables: "",
  modelNotes: "",
  exampleInput: "",
  exampleOutput: "",
  usageNotes: "",
  changeNote: "",
  authorName: "Public author",
  authorBio: "Explicit public bio",
  consent: true,
};
type Scope = { c: PoolClient; author: Actor; reader: Actor; admin: Actor };
async function scenario(work: (s: Scope) => Promise<void>) {
  await ensureDatabaseReady();
  const c = await getPool().connect();
  await c.query("BEGIN");
  try {
    const account = (role: Actor["role"]) =>
      createAccountInTransaction(
        c,
        `community-${randomUUID()}@example.test`,
        "scrypt$rollback-only",
        role,
      );
    await work({
      c,
      author: await account("USER"),
      reader: await account("USER"),
      admin: await account("ADMIN"),
    });
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
const create = (s: Scope, overrides = {}) =>
  publish(s.c, s.author, publication({ ...input, ...overrides }), randomUUID());
const query = (extra = "") => new URLSearchParams(extra);
describe.skipIf(process.env.PROMPTMASTER_COMMUNITY_DB_TEST !== "true")(
  "community database boundaries",
  () => {
    afterAll(async () => {
      await getPool().end();
    });
    it("discovers multi-purpose snapshots by synonyms, all search terms, tags and public visibility", () =>
      scenario(async (s) => {
        const relevant = await create(s, {
          title: "简历优化与面试",
          summary: "求职指导",
          content: "改进经历描述",
          language: "zh-CN",
          purposes: ["improve", "plan"],
          tags: ["简历修改", "职场"],
        });
        const bodyMatch = await create(s, {
          title: "求职工具",
          summary: "真实内容",
          content: "简历修改与面试准备",
          language: "zh-CN",
          purposes: ["improve"],
          tags: [],
        });
        const irrelevant = await create(s, { title: "咖啡开业", content: "热门咖啡店开业广告" });
        await star(s.c, s.reader, irrelevant.publicId, true, 1);
        const found = await list(s.c, query("q=简历修改 面试&purpose=improve&language=zh-CN"));
        expect(found.items.map((p) => p.id)).toEqual([relevant.publicId, bodyMatch.publicId]);
        expect(found.total).toBe(2);
        expect(found.items[0].purposes).toEqual(["improve", "plan"]);
        expect(
          (await list(s.c, query("q=简历优化 面试&sort=stars"))).items.map((p) => p.id),
        ).not.toContain(irrelevant.publicId);
        expect(
          (await list(s.c, query("purpose=plan&tag=简历优化"))).items.map((p) => p.id),
        ).toEqual([relevant.publicId]);
        expect((await list(s.c, query("q=简历修改 不存在"))).total).toBe(0);
        await withdraw(s.c, s.author, bodyMatch.publicId);
        await moderate(
          s.c,
          s.admin,
          { action: "remove", publicId: relevant.publicId, reason: "Synthetic moderation" },
          randomUUID(),
        );
        expect((await list(s.c, query("q=简历优化"))).total).toBe(0);
      }));
    it("keeps old classification fallback, explicit no-purpose choices and per-version descriptions distinct", () =>
      scenario(async (s) => {
        const legacy = await create(s, { content: "Legacy writing" });
        const empty = await create(s, { content: "Unclassified writing", purposes: [] });
        expect((await detail(s.c, legacy.publicId)).purposes).toEqual(["create"]);
        expect((await detail(s.c, empty.publicId)).purposes).toEqual([]);
        await update(
          s.c,
          s.author,
          empty.publicId,
          publication(
            {
              ...input,
              content: "Unclassified writing",
              purposes: ["analyze", "create"],
              tags: ["数据"],
              baseVersion: 1,
              changeNote: "Organized discovery",
            },
            true,
          ),
          randomUUID(),
        );
        expect((await detail(s.c, empty.publicId, 1)).purposes).toEqual([]);
        expect((await detail(s.c, empty.publicId)).purposes).toEqual(["analyze", "create"]);
        await s.c.query("SAVEPOINT purpose_guard");
        await expect(
          s.c.query("UPDATE community_publications SET purposes=ARRAY['build'] WHERE id=$1", [
            empty.publicId,
          ]),
        ).rejects.toThrow("newly consented version");
        await s.c.query("ROLLBACK TO SAVEPOINT purpose_guard");
        const copied = await copy(s.c, s.reader, empty.publicId, 2, randomUUID());
        expect((await source(s.c, s.reader, copied.versionId)).descriptor).toEqual({
          purposes: ["analyze", "create"],
          tags: ["数据"],
        });
        await expect(source(s.c, s.author, copied.versionId)).rejects.toThrow(
          "PROMPT_VERSION_NOT_FOUND",
        );
      }));
    it("paginates relevance ties without duplicate rows or counts", () =>
      scenario(async (s) => {
        for (let n = 0; n < 22; n++)
          await publish(
            s.c,
            n < 19 ? s.author : s.reader,
            publication({
              ...input,
              title: "Pagination research",
              content: `pagination body ${n}`,
              purposes: ["analyze"],
            }),
            randomUUID(),
          );
        const first = await list(s.c, query("q=pagination&purpose=analyze"));
        const second = await list(s.c, query("q=pagination&purpose=analyze&page=2"));
        expect(first.total).toBe(22);
        expect(second.total).toBe(22);
        expect(new Set([...first.items, ...second.items].map((p) => p.id)).size).toBe(22);
        expect(
          (await list(s.c, query("q=pagination&purpose=analyze"))).items.map((p) => p.id),
        ).toEqual(first.items.map((p) => p.id));
      }));
    it("publishes immutable independent snapshots with no account/private identifiers in public DTOs", () =>
      scenario(async (s) => {
        const p = await create(s);
        const d = await detail(s.c, p.publicId);
        expect(d.version.content).toBe(input.content);
        expect(d.author.id).not.toBe(s.author.id);
        expect(JSON.stringify(d)).not.toContain(s.author.email);
        expect(JSON.stringify(d)).not.toContain(s.author.id);
        await s.c.query("SAVEPOINT immutable");
        await expect(
          s.c.query("UPDATE community_versions SET content='tampered' WHERE public_id=$1", [
            p.publicId,
          ]),
        ).rejects.toThrow();
        await s.c.query("ROLLBACK TO SAVEPOINT immutable");
        expect((await detail(s.c, p.publicId)).version.content).toBe(input.content);
      }));
    it("paginates every moderation collection independently and prioritizes old open reports", () =>
      scenario(async (s) => {
        const p = await create(s);
        const oldReport = `report_${randomUUID()}`;
        await s.c.query(
          "INSERT INTO community_reports(id,public_id,actor_id,category,detail,status,created_at) SELECT 'report_'||md5($1||g::text)::uuid::text,$1,$2,'privacy','Synthetic archived concern','DISMISSED',now() FROM generate_series(1,105) g",
          [p.publicId, s.reader.id],
        );
        await s.c.query(
          "INSERT INTO community_reports(id,public_id,actor_id,category,detail,created_at) SELECT 'report_'||md5('open'||$1||g::text)::uuid::text,$1,$2,'privacy','New unresolved concern',now() FROM generate_series(1,101) g",
          [p.publicId, s.reader.id],
        );
        await s.c.query(
          "INSERT INTO community_reports(id,public_id,actor_id,category,detail,created_at) VALUES($1,$2,$3,'privacy','Old unresolved concern',now()-interval '1 year')",
          [oldReport, p.publicId, s.reader.id],
        );
        const readerIds = Array.from({ length: 101 }, () => `usr_${randomUUID()}`);
        await s.c.query(
          "INSERT INTO app_users(id,identity_key,account_kind) SELECT x,'synthetic-moderation:'||x,'USER' FROM unnest($1::text[]) x",
          [readerIds],
        );
        await s.c.query(
          "INSERT INTO community_stars(id,public_id,actor_id,first_starred_at) SELECT 'star_'||md5(x)::uuid::text,$1,x,now()-ordinality*interval '1 day' FROM unnest($2::text[]) WITH ORDINALITY AS r(x,ordinality)",
          [p.publicId, readerIds],
        );
        const earlyStar = `star_${(await s.c.query<{ hash: string }>("SELECT md5($1)::uuid::text hash", [readerIds[100]])).rows[0].hash}`;
        await s.c.query(
          "INSERT INTO community_events(id,public_id,actor_id,action,reason,created_at) SELECT 'event_'||md5($1||g::text)::uuid::text,$1,$2,'review','Synthetic historical audit',now()-g*interval '1 day' FROM generate_series(1,101) g",
          [p.publicId, s.admin.id],
        );
        const first = await moderation(s.c, s.admin, p.publicId);
        expect(first.reports.every((r) => r.status === "OPEN")).toBe(true);
        expect(first.paging).toEqual({
          reports: { page: 1, total: 207, pageSize: 100 },
          stars: { page: 1, total: 101, pageSize: 100 },
          events: { page: 1, total: 101, pageSize: 100 },
        });
        const second = await moderation(s.c, s.admin, p.publicId, {
          reportsPage: 2,
          starsPage: 2,
          eventsPage: 2,
        });
        expect(second.reports).toHaveLength(100);
        expect(second.reports[1].id).toBe(oldReport);
        expect(second.stars.map((r) => r.id)).toEqual([earlyStar]);
        expect(second.events).toHaveLength(1);
        const third = await moderation(s.c, s.admin, p.publicId, { reportsPage: 3 });
        expect(third.reports).toHaveLength(7);
        expect(
          new Set([...first.reports, ...second.reports, ...third.reports].map((r) => r.id)).size,
        ).toBe(207);
        expect(new Set([...first.events, ...second.events].map((r) => r.id)).size).toBe(101);
        expect(second.paging.reports.page).toBe(2);
        const independent = await moderation(s.c, s.admin, p.publicId, { reportsPage: 2 });
        expect(independent.reports).toEqual(second.reports);
        expect(independent.stars).toEqual(first.stars);
        expect(independent.events).toEqual(first.events);
        const beyond = await moderation(s.c, s.admin, p.publicId, {
          reportsPage: 4,
          starsPage: 3,
          eventsPage: 3,
        });
        expect(beyond.reports).toEqual([]);
        expect(beyond.stars).toEqual([]);
        expect(beyond.events).toEqual([]);
        expect(beyond.paging.reports.total).toBe(207);
        expect((await moderation(s.c, s.admin)).stars).toEqual([]);
        await moderate(
          s.c,
          s.admin,
          { action: "dismiss", reportId: oldReport, reason: "Resolved from page two" },
          randomUUID(),
        );
        await moderate(
          s.c,
          s.admin,
          {
            action: "excludeStar",
            starId: earlyStar,
            reason: "Reviewed early relation from page two",
          },
          randomUUID(),
        );
        expect(
          (await s.c.query("SELECT status FROM community_reports WHERE id=$1", [oldReport])).rows[0]
            .status,
        ).toBe("DISMISSED");
        expect(
          (await s.c.query("SELECT excluded FROM community_stars WHERE id=$1", [earlyStar])).rows[0]
            .excluded,
        ).toBe(true);
      }));
    it("checks ownership, idempotency, optimistic versions and withdrawal for every version", () =>
      scenario(async (s) => {
        const key = randomUUID();
        const parsed = publication(input);
        const p = await publish(s.c, s.author, parsed, key);
        expect(await publish(s.c, s.author, parsed, key)).toEqual(p);
        await expect(
          publish(s.c, s.author, publication({ ...input, title: "Changed" }), key),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        const patch = publication(
          {
            ...input,
            content: "Updated content",
            baseVersion: 1,
            changeNote: "Update",
            consent: true,
          },
          true,
        );
        await expect(update(s.c, s.reader, p.publicId, patch, randomUUID())).rejects.toMatchObject({
          status: 404,
        });
        const updated = await update(s.c, s.author, p.publicId, patch, "update-test-key");
        expect(updated.versionNumber).toBe(2);
        expect(await update(s.c, s.author, p.publicId, patch, "update-test-key")).toEqual(updated);
        await expect(update(s.c, s.author, p.publicId, patch, randomUUID())).rejects.toMatchObject({
          code: "VERSION_CONFLICT",
        });
        expect((await detail(s.c, p.publicId, 1)).version.content).toBe(input.content);
        expect((await detail(s.c, p.publicId, 1)).versionNumber).toBe(2);
        await expect(
          publish(s.c, s.author, publication(input), randomUUID()),
        ).rejects.toMatchObject({ code: "ALREADY_PUBLISHED" });
        await withdraw(s.c, s.author, p.publicId);
        await expect(detail(s.c, p.publicId, 1)).rejects.toMatchObject({ status: 404 });
        await expect(detail(s.c, p.publicId, 2)).rejects.toMatchObject({ status: 404 });
        expect((await list(s.c, query())).items).toHaveLength(0);
        expect((await ownedDetail(s.c, s.author, p.publicId)).status).toBe("WITHDRAWN");
        await expect(ownedDetail(s.c, s.reader, p.publicId)).rejects.toMatchObject({ status: 404 });
      }));
    it("copies exact versions once and retains independent private copies after withdrawal", () =>
      scenario(async (s) => {
        const p = await create(s);
        const key = randomUUID();
        const saved = await copy(s.c, s.reader, p.publicId, 1, key);
        expect(await copy(s.c, s.reader, p.publicId, 1, key)).toEqual(saved);
        expect((await source(s.c, s.reader, saved.versionId)).content).toBe(input.content);
        await expect(source(s.c, s.author, saved.versionId)).rejects.toMatchObject({ status: 404 });
        await expect(copySource(s.c, s.author, saved.promptId)).rejects.toMatchObject({
          status: 404,
        });
        await withdraw(s.c, s.author, p.publicId);
        expect(await copy(s.c, s.reader, p.publicId, 1, key)).toEqual(saved);
        expect((await copySource(s.c, s.reader, saved.promptId))?.available).toBe(false);
        expect(
          (
            await s.c.query("SELECT count(*)::int n FROM library_items WHERE owner_user_id=$1", [
              s.reader.id,
            ])
          ).rows[0].n,
        ).toBe(1);
      }));
    it("verifies selected private source and rejects unchanged republishing", () =>
      scenario(async (s) => {
        const p = await create(s);
        const saved = await copy(s.c, s.reader, p.publicId, 1, randomUUID());
        await expect(
          publish(
            s.c,
            s.author,
            publication({ ...input, sourceVersionId: saved.versionId }),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          publish(
            s.c,
            s.reader,
            publication({ ...input, content: "Mismatch", sourceVersionId: saved.versionId }),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ code: "SOURCE_CONTENT_MISMATCH" });
        await expect(
          publish(
            s.c,
            s.reader,
            publication({ ...input, sourceVersionId: saved.versionId }),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ code: "ALREADY_PUBLISHED" });
        await expect(
          publish(s.c, s.author, publication(input), randomUUID()),
        ).rejects.toMatchObject({ code: "ALREADY_PUBLISHED" });
      }));
    it("counts true star relationships and keeps the first timestamp after re-Star", () =>
      scenario(async (s) => {
        const p = await create(s);
        await expect(star(s.c, s.author, p.publicId, true, 1)).rejects.toMatchObject({
          code: "SELF_STAR_FORBIDDEN",
        });
        expect((await star(s.c, s.reader, p.publicId, true, 1)).stars).toBe(1);
        const first = (
          await s.c.query("SELECT first_starred_at FROM community_stars WHERE public_id=$1", [
            p.publicId,
          ])
        ).rows[0].first_starred_at;
        expect((await star(s.c, s.reader, p.publicId, true, 1)).stars).toBe(1);
        expect((await star(s.c, s.reader, p.publicId, false, 1)).stars).toBe(0);
        expect((await star(s.c, s.reader, p.publicId, true, 1)).stars).toBe(1);
        expect(
          (
            await s.c.query("SELECT first_starred_at FROM community_stars WHERE public_id=$1", [
              p.publicId,
            ])
          ).rows[0].first_starred_at,
        ).toEqual(first);
        expect((await viewer(s.c, s.reader, p.publicId)).starred).toBe(true);
      }));
    it("restricts governance to admins, audits exclusions and blocks removed author updates", () =>
      scenario(async (s) => {
        const p = await create(s);
        await star(s.c, s.reader, p.publicId, true, 1);
        const reportKey = randomUUID();
        const concern = { category: "privacy" as const, detail: "Synthetic concern" };
        const reported = await report(s.c, s.reader, p.publicId, concern, reportKey);
        await expect(moderation(s.c, s.reader, p.publicId)).rejects.toMatchObject({
          code: "ADMIN_REQUIRED",
        });
        const review = await moderation(s.c, s.admin, p.publicId);
        expect(review.reports).toHaveLength(1);
        await moderate(
          s.c,
          s.admin,
          { action: "excludeStar", starId: review.stars[0].id, reason: "Synthetic exclusion" },
          randomUUID(),
        );
        expect((await detail(s.c, p.publicId)).stars).toBe(0);
        await moderate(
          s.c,
          s.admin,
          { action: "remove", publicId: p.publicId, reason: "Synthetic removal" },
          randomUUID(),
        );
        expect(await report(s.c, s.reader, p.publicId, concern, reportKey)).toEqual(reported);
        await expect(detail(s.c, p.publicId)).rejects.toMatchObject({ status: 404 });
        await expect(
          update(
            s.c,
            s.author,
            p.publicId,
            publication({ ...input, baseVersion: 1, changeNote: "Try restore" }, true),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ code: "PUBLICATION_REMOVED" });
        await moderate(
          s.c,
          s.admin,
          { action: "restore", publicId: p.publicId, reason: "Synthetic restore" },
          randomUUID(),
        );
        expect((await detail(s.c, p.publicId)).status).toBe("PUBLISHED");
      }));
    it("preserves source whitespace and isolates public snapshots from private edits", () =>
      scenario(async (s) => {
        const promptId = `prm_${randomUUID()}`,
          versionId = `ver_${randomUUID()}`,
          content = "  Exact body\r\n\n";
        await s.c.query(
          "INSERT INTO prompts(id,owner_user_id,kind,title,task_type,current_version_id) VALUES($1,$2,'PERSONAL_PROMPT','Private title','Writing',$3)",
          [promptId, s.author.id, versionId],
        );
        await s.c.query(
          "INSERT INTO prompt_versions(id,prompt_id,owner_user_id,version_number,title,content,created_by,source) VALUES($1,$2,$3,1,'Private version',$4,$3,'MANUAL_DRAFT')",
          [versionId, promptId, s.author.id, content],
        );
        const p = await create(s, { content, sourceVersionId: versionId });
        await s.c.query("UPDATE prompt_versions SET content='Changed privately' WHERE id=$1", [
          versionId,
        ]);
        expect((await detail(s.c, p.publicId)).version.content).toBe(content);
        expect(JSON.stringify(await detail(s.c, p.publicId))).not.toContain(versionId);
        const saved = await copy(s.c, s.reader, p.publicId, 1, randomUUID());
        expect((await source(s.c, s.reader, saved.versionId)).content).toBe(content);
      }));
    it("stores immutable consent for each version and hides withdrawn origin metadata", () =>
      scenario(async (s) => {
        const p = await create(s);
        const derivative = await publish(
          s.c,
          s.reader,
          publication({
            ...input,
            content: "Adapted public content",
            sourcePublicId: p.publicId,
            sourcePublicVersion: 1,
          }),
          randomUUID(),
        );
        await update(
          s.c,
          s.author,
          p.publicId,
          publication(
            { ...input, content: "Revision", baseVersion: 1, changeNote: "Revision" },
            true,
          ),
          randomUUID(),
        );
        const consents = await s.c.query(
          "SELECT consent_snapshot FROM community_versions WHERE public_id=$1 ORDER BY version_number",
          [p.publicId],
        );
        expect(consents.rows).toHaveLength(2);
        expect(
          consents.rows.every(
            (r) => r.consent_snapshot.accepted === true && r.consent_snapshot.license === "CC0-1.0",
          ),
        ).toBe(true);
        await withdraw(s.c, s.author, p.publicId);
        const d = await detail(s.c, derivative.publicId);
        expect(d.version.origin?.available).toBe(false);
        expect(d.version.origin?.title).toBe("");
      }));
    it("keeps viewer identity read-only, opaque and stable before publishing", () =>
      scenario(async (s) => {
        const a = await viewer(s.c, s.author);
        const b = await viewer(s.c, s.author);
        expect(a).toEqual(b);
        expect(a.user?.name).toBe("");
        expect(JSON.stringify(a)).not.toContain(s.author.email);
        expect(JSON.stringify(a)).not.toContain(s.author.id);
        expect(
          (
            await s.c.query(
              "SELECT count(*)::int n FROM community_creators WHERE owner_user_id=$1",
              [s.author.id],
            )
          ).rows[0].n,
        ).toBe(0);
        const p = await create(s);
        expect((await detail(s.c, p.publicId)).author.id).toBe(a.user?.id);
        expect((await creatorProfile(s.c, a.user!.id)).name).toBe(input.authorName);
      }));
    it("uses precise active counts, rolling seven days and deterministic ranking ties", () =>
      scenario(async (s) => {
        const p1 = await create(s, { content: "Ranking old" }),
          p2 = await create(s, { content: "Ranking recent" }),
          p3 = await create(s, { content: "Ranking tie" });
        for (const p of [p1, p2, p3])
          await s.c.query(
            "INSERT INTO community_stars(id,public_id,actor_id,first_starred_at) VALUES($1,$2,$3,now()-$4::interval)",
            [`star_${randomUUID()}`, p.publicId, s.reader.id, p === p1 ? "8 days" : "1 day"],
          );
        await s.c.query(
          "INSERT INTO community_stars(id,public_id,actor_id,first_starred_at) VALUES($1,$2,$3,now()-interval '8 days')",
          [`star_${randomUUID()}`, p1.publicId, s.admin.id],
        );
        expect((await list(s.c, query("sort=stars"))).items[0].id).toBe(p1.publicId);
        const recent = await list(s.c, query("sort=recent"));
        expect(recent.items.map((p) => p.id)).toEqual(
          [p2.publicId, p3.publicId].sort().concat(p1.publicId),
        );
        expect(recent.items.find((p) => p.id === p1.publicId)?.recentStars).toBe(0);
        await star(s.c, s.reader, p1.publicId, false, 1);
        await star(s.c, s.reader, p1.publicId, true, 1);
        expect((await detail(s.c, p1.publicId)).recentStars).toBe(0);
        const starred = await list(s.c, query("tab=starred"), s.reader);
        expect(starred.total).toBe(3);
        const stable = await list(s.c, query("sort=newest"));
        expect(stable.items.map((p) => p.id)).toEqual(
          [p1.publicId, p2.publicId, p3.publicId].sort(),
        );
        const info = await moderation(s.c, s.admin, p1.publicId);
        const relation = info.stars[0];
        await moderate(
          s.c,
          s.admin,
          { action: "excludeStar", starId: relation.id, reason: "Synthetic" },
          randomUUID(),
        );
        expect((await detail(s.c, p1.publicId)).stars).toBe(1);
        await moderate(
          s.c,
          s.admin,
          { action: "restoreStar", starId: relation.id, reason: "Synthetic" },
          randomUUID(),
        );
        expect((await detail(s.c, p1.publicId)).stars).toBe(2);
      }));
    it("filters full body text, categories, language and author with stable pagination", () =>
      scenario(async (s) => {
        for (let i = 0; i < 20; i++)
          await create(s, {
            content: `PAGINATED needle-${i}`,
            language: i % 2 ? "zh-CN" : "en",
            taskType: i % 2 ? "Coding" : "Writing",
          });
        await publish(
          s.c,
          s.reader,
          publication({ ...input, content: "PAGINATED reader-content" }),
          randomUUID(),
        );
        const page1 = await list(s.c, query("q=PAGINATED&page=1"));
        const page2 = await list(s.c, query("q=PAGINATED&page=2"));
        expect(page1.total).toBe(21);
        expect(page1.items).toHaveLength(20);
        expect(page2.items).toHaveLength(1);
        expect(new Set([...page1.items, ...page2.items].map((p) => p.id)).size).toBe(21);
        const creator = (await viewer(s.c, s.author)).user!.id;
        expect(
          (await list(s.c, query(`author=${creator}&category=Coding&language=zh-CN`))).total,
        ).toBe(10);
        expect((await list(s.c, query("q=needle-19"))).total).toBe(1);
        expect((await list(s.c, query("q=%25"))).total).toBe(0);
        expect((await list(s.c, query("page=3"))).total).toBe(21);
      }));
    it("applies identical UTC new-publication limits to users and admins without charging receipt retries", () =>
      scenario(async (s) => {
        const old = process.env.PROMPTMASTER_COMMUNITY_PUBLISH_DAILY_LIMIT;
        process.env.PROMPTMASTER_COMMUNITY_PUBLISH_DAILY_LIMIT = "2";
        try {
          for (const user of [s.author, s.admin]) {
            const key = randomUUID(),
              payload = publication({ ...input, content: `Rate A ${user.id}` });
            const p = await publish(s.c, user, payload, key);
            await publish(
              s.c,
              user,
              publication({ ...input, content: `Rate B ${user.id}` }),
              randomUUID(),
            );
            await expect(
              publish(
                s.c,
                user,
                publication({ ...input, content: `Rate C ${user.id}` }),
                randomUUID(),
              ),
            ).rejects.toMatchObject({ code: "PUBLISH_DAILY_LIMIT" });
            expect(await publish(s.c, user, payload, key)).toEqual(p);
            expect(
              (
                await s.c.query(
                  "SELECT bucket=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS utc FROM community_write_limits WHERE actor_id=$1 AND operation='publish'",
                  [user.id],
                )
              ).rows[0].utc,
            ).toBe(true);
          }
        } finally {
          if (old === undefined) delete process.env.PROMPTMASTER_COMMUNITY_PUBLISH_DAILY_LIMIT;
          else process.env.PROMPTMASTER_COMMUNITY_PUBLISH_DAILY_LIMIT = old;
        }
      }));
    it("enforces private capacity atomically and replays successful copies even when capacity is full", () =>
      scenario(async (s) => {
        const p = await create(s);
        const fill = Array.from({ length: 100 }, () => `prm_${randomUUID()}`);
        await s.c.query(
          "INSERT INTO prompts(id,owner_user_id,kind,title,task_type) SELECT x,$1,'PERSONAL_PROMPT','Synthetic capacity','Writing' FROM unnest($2::text[]) x",
          [s.reader.id, fill],
        );
        await s.c.query("SAVEPOINT capacity_rejection");
        await expect(copy(s.c, s.reader, p.publicId, 1, randomUUID())).rejects.toMatchObject({
          code: "PROMPT_CAPACITY_EXCEEDED",
        });
        await s.c.query("ROLLBACK TO SAVEPOINT capacity_rejection");
        expect(
          (
            await s.c.query(
              "SELECT count(*)::int n FROM community_copy_sources WHERE owner_user_id=$1",
              [s.reader.id],
            )
          ).rows[0].n,
        ).toBe(0);
        await s.c.query("DELETE FROM prompts WHERE id=$1 AND owner_user_id=$2", [
          fill[0],
          s.reader.id,
        ]);
        const key = randomUUID(),
          saved = await copy(s.c, s.reader, p.publicId, 1, key);
        expect(await copy(s.c, s.reader, p.publicId, 1, key)).toEqual(saved);
        await expect(source(s.c, s.admin, saved.versionId)).rejects.toMatchObject({ status: 404 });
        await moderate(
          s.c,
          s.admin,
          { action: "remove", publicId: p.publicId, reason: "Synthetic moderation" },
          randomUUID(),
        );
        expect((await source(s.c, s.reader, saved.versionId)).content).toBe(input.content);
        expect(await copy(s.c, s.reader, p.publicId, 1, key)).toEqual(saved);
        await expect(copy(s.c, s.reader, p.publicId, 1, randomUUID())).rejects.toMatchObject({
          status: 404,
        });
      }));
    it("preserves verified one-layer provenance when improving an owned copy after removal", () =>
      scenario(async (s) => {
        const p = await create(s);
        const saved = await copy(s.c, s.reader, p.publicId, 1, randomUUID());
        const versionId = `ver_${randomUUID()}`;
        await s.c.query(
          "INSERT INTO prompt_versions(id,prompt_id,owner_user_id,version_number,title,content,created_by,source,parent_version_id) VALUES($1,$2,$3,2,'Improvement','Improved independent content',$3,'MANUAL_DRAFT',$4)",
          [versionId, saved.promptId, s.reader.id, saved.versionId],
        );
        await s.c.query(
          "UPDATE prompts SET current_version_id=$1 WHERE id=$2 AND owner_user_id=$3",
          [versionId, saved.promptId, s.reader.id],
        );
        await withdraw(s.c, s.author, p.publicId);
        const derived = await publish(
          s.c,
          s.reader,
          publication({
            ...input,
            content: "Improved independent content",
            sourceVersionId: versionId,
          }),
          randomUUID(),
        );
        const d = await detail(s.c, derived.publicId);
        expect(d.version.origin).toEqual({
          publicId: p.publicId,
          versionNumber: 1,
          title: "",
          available: false,
        });
        const again = await copy(s.c, s.admin, derived.publicId, 1, randomUUID());
        expect((await copySource(s.c, s.admin, again.promptId))?.publicId).toBe(derived.publicId);
        await expect(
          publish(
            s.c,
            s.admin,
            publication({
              ...input,
              content: "Claim",
              sourcePublicId: p.publicId,
              sourcePublicVersion: 1,
            }),
            randomUUID(),
          ),
        ).rejects.toMatchObject({ status: 404 });
      }));
    it("serializes concurrent duplicate publish and stars across committed transactions", async () => {
      const accounts = await withTransaction(async (c) => ({
        author: await createAccountInTransaction(
          c,
          `parallel-${randomUUID()}@example.test`,
          "scrypt$rollback-only",
          "USER",
        ),
        reader: await createAccountInTransaction(
          c,
          `parallel-${randomUUID()}@example.test`,
          "scrypt$rollback-only",
          "USER",
        ),
      }));
      const key = randomUUID();
      const payload = publication({ ...input, content: randomUUID() });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          withTransaction((c) => publish(c, accounts.author, payload, key)),
        ),
      );
      expect(new Set(results.map((r) => r.publicId)).size).toBe(1);
      const stars = await Promise.all(
        Array.from({ length: 4 }, () =>
          withTransaction((c) => star(c, accounts.reader, results[0].publicId, true, 1)),
        ),
      );
      expect(stars.every((s) => s.stars === 1)).toBe(true);
      const copyKey = randomUUID();
      const copies = await Promise.all(
        Array.from({ length: 4 }, () =>
          withTransaction((c) => copy(c, accounts.reader, results[0].publicId, 1, copyKey)),
        ),
      );
      expect(new Set(copies.map((r) => r.promptId)).size).toBe(1);
      const revisions = await Promise.allSettled(
        ["Concurrent first", "Concurrent second"].map((content) =>
          withTransaction((c) =>
            update(
              c,
              accounts.author,
              results[0].publicId,
              publication(
                { ...input, content, baseVersion: 1, changeNote: "Concurrent update" },
                true,
              ),
              randomUUID(),
            ),
          ),
        ),
      );
      expect(revisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(revisions.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "VERSION_CONFLICT" },
      });
    });
  },
);
