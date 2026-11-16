import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const testDb = vi.hoisted(() => ({ client: null as PoolClient | null }));
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getPool: () =>
      new Proxy(actual.getPool(), {
        get(target, key) {
          if (key === "query" && testDb.client) return testDb.client.query.bind(testDb.client);
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    withTransaction: async <T>(work: (c: PoolClient) => Promise<T>) =>
      testDb.client ? work(testDb.client) : actual.withTransaction(work),
  };
});
vi.mock("./skills/github-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./skills/github-provider")>()),
  fetchGithubSkill: vi.fn(),
  inspectGithubSource: vi.fn(),
}));
vi.mock("./model/deepseek-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model/deepseek-provider")>()),
  generateWithChatModel: vi.fn(),
}));
import { ensureDatabaseReady, getPool } from "./db";
import { hashPassword, verifyPassword } from "./password";
import {
  authenticate,
  createAccountInTransaction,
  createSession,
  sessionActor,
  logout,
  credentials,
} from "./accounts";
import { accountContext, type Actor, workspaceOwnerId } from "./identity-context";
import { recommendSkill, reviewSkill, skillContent, libraryOverview } from "./skills/skill-library";
import {
  beginGithubImportInTransaction,
  completeGithubImportInTransaction,
  importGithubSkill,
} from "./skills/github-registry";
import { fixtureInput, fixtureApproval, githubFixture } from "./skills/github-fixture";
import { fetchGithubSkill, inspectGithubSource } from "./skills/github-provider";
import { SkillInputError } from "./skills/skill-parser";
import { POST as sourcePost } from "@/app/api/skills/sources/route";
import { POST as importPost } from "@/app/api/skills/imports/route";
import { GET as libraryGet, POST as libraryPost } from "@/app/api/skills/library/route";
import { GET as accountsGet } from "@/app/api/accounts/route";
import { GET as snapshotGet } from "@/app/api/demo/snapshot/route";
import { POST as promptPost } from "@/app/api/prompts/route";
import { POST as versionPost } from "@/app/api/prompts/[promptId]/versions/route";
import { getSnapshot } from "./repository";
import { GET as jobGet } from "@/app/api/skills/imports/[jobId]/route";
import { withdrawSkill } from "./skills/skill-library";
import { registerOfflineSkillInTransaction } from "./skills/skill-registry";
import { syntheticSkill } from "./skills/skill-fixture";
import { loadSkillContext, loadWorkflowContext } from "./skills/skill-context";
import {
  createSkillPlan,
  runSkillPlan,
  skillWorkflowStatus,
} from "./skills/skill-workflow-service";
import { generateLivePrompt } from "./model/model-service";
import { POST as workflowPost } from "@/app/api/skills/workflow/route";
import {
  createPrompt,
  createPromptVersion,
  getPromptForEvaluation,
  getPromptVersion,
  saveOptimization,
} from "./repository";
import { generateWithChatModel as generateWithDeepSeek } from "./model/deepseek-provider";
import { ModelServiceError } from "./model/model-errors";
import { POST as offlinePost } from "@/app/api/skills/offline/route";
import { GET as provenanceGet } from "@/app/api/skills/provenance/route";
const password = "Synthetic-testing-only-2026!";
describe.skipIf(process.env.PROMPTMASTER_ACCOUNT_DB_TEST !== "true")(
  "real account and library permissions (rollback-only, no external services)",
  () => {
    let c: PoolClient, admin: Actor, user: Actor, other: Actor, encoded: string;
    beforeAll(async () => {
      await ensureDatabaseReady();
      encoded = await hashPassword(password);
    });
    beforeEach(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw new Error("Supplier network forbidden in account tests");
        }),
      );
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
      c = await getPool().connect();
      await c.query("BEGIN");
      testDb.client = c;
      admin = await createAccountInTransaction(
        c,
        `admin-${randomUUID()}@example.test`,
        encoded,
        "ADMIN",
      );
      user = await createAccountInTransaction(
        c,
        `user-${randomUUID()}@example.test`,
        encoded,
        "USER",
      );
      other = await createAccountInTransaction(
        c,
        `other-${randomUUID()}@example.test`,
        encoded,
        "USER",
      );
    });
    afterEach(async () => {
      testDb.client = null;
      await c.query("ROLLBACK");
      c.release();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });
    afterAll(async () => {
      await getPool().end();
    });
    const token = async (actor: Actor) => createSession(actor);
    it("keeps uncategorized descriptor metadata out of the body and avoids unchanged optimization versions", async () => {
      await accountContext.run(user, async () => {
        const descriptor = { purposes: ["analyze", "create"] as const, tags: ["汇报"] };
        const content = "分析销售数据，写一段给老板的汇报。金额 500 元，截止 2026-11-10。";
        const created = await createPrompt({
          title: "Mixed task",
          taskType: "General",
          content,
          descriptor: { purposes: [...descriptor.purposes], tags: descriptor.tags },
        });
        expect((await getPromptForEvaluation(created.promptId))?.descriptor).toEqual(descriptor);
        expect((await getPromptVersion(created.promptId, created.versionId))?.content).toBe(
          content,
        );
        const optimizationId = `opt_${randomUUID()}`;
        await c.query(
          "INSERT INTO optimization_records(id,owner_user_id,prompt_id,source_prompt_version_id,proposed_content,source) VALUES($1,$2,$3,$4,$5,'MOCK_SIMULATED')",
          [optimizationId, user.id, created.promptId, created.versionId, content],
        );
        const before = await c.query("SELECT count(*) FROM prompt_versions WHERE prompt_id=$1", [
          created.promptId,
        ]);
        const applied = await createPromptVersion({
          promptId: created.promptId,
          content,
          baseVersionId: created.versionId,
          source: "MODEL_OPTIMIZATION",
          optimizationId,
        });
        expect(applied).toMatchObject({ versionId: created.versionId, unchanged: true });
        const replay = await createPromptVersion({
          promptId: created.promptId,
          content,
          baseVersionId: created.versionId,
          source: "MODEL_OPTIMIZATION",
          optimizationId,
        });
        expect(replay?.versionId).toBe(created.versionId);
        expect(
          (
            await c.query("SELECT count(*) FROM prompt_versions WHERE prompt_id=$1", [
              created.promptId,
            ])
          ).rows,
        ).toEqual(before.rows);
        expect(
          (await c.query("SELECT count(*) FROM optimization_records WHERE id=$1", [optimizationId]))
            .rows[0].count,
        ).toBe("1");
      });
    });
    function req(path: string, session?: string, body?: unknown) {
      return new Request(`http://localhost:3000${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          ...(session ? { cookie: `pm_session=${session}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function imported(actor: Actor, body?: string) {
      const bundle = githubFixture(body).bundle;
      const work = await beginGithubImportInTransaction(c, actor.id, fixtureInput, randomUUID(), [
        fixtureApproval,
      ]);
      const result = await completeGithubImportInTransaction(c, actor.id, work, bundle, {
        actor,
        riskAccepted: true,
      });
      expect(result.status).toBe("REGISTERED");
      return result;
    }
    async function sqlReject(sql: string, values: unknown[]) {
      await c.query("SAVEPOINT expected_error");
      try {
        await expect(c.query(sql, values)).rejects.toBeTruthy();
      } finally {
        await c.query("ROLLBACK TO SAVEPOINT expected_error");
      }
    }
    async function offline(actor: Actor, body = "Use explicit inputs, constraints and checks.") {
      return registerOfflineSkillInTransaction(
        c,
        syntheticSkill(undefined, body),
        randomUUID(),
        actor.id,
        { actor, riskAccepted: true },
      );
    }
    function configureSyntheticModel() {
      for (const [key, value] of Object.entries({
        PROMPTMASTER_MODEL_MODE: "live",
        PROMPTMASTER_MODEL_PROVIDER: "deepseek",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
        DEEPSEEK_API_KEY: "synthetic-unused-no-network",
        DEEPSEEK_MODEL: "deepseek-flash",
        DEEPSEEK_PRODUCT_VERSION: "DeepSeek-V4.1-Flash-1017",
        PROMPTMASTER_MODEL_MAX_RETRIES: "0",
        PROMPTMASTER_MODEL_MAX_OUTPUT_TOKENS: "100",
        PROMPTMASTER_MODEL_DAILY_TOKEN_LIMIT: "100000",
        PROMPTMASTER_MODEL_DAILY_COST_LIMIT_USD: "1",
      }))
        vi.stubEnv(key, value);
      vi.mocked(generateWithDeepSeek).mockImplementation(async (_config, _input, hooks) => {
        await hooks?.beforeAttempt?.();
        return {
          content:
            _input.kind === "OPTIMIZATION"
              ? "SYNTHETIC IMPROVED PROMPT"
              : "SYNTHETIC ADAPTED PROMPT",
          resolvedModel: "deepseek-flash",
          usage: { promptTokens: 200, completionTokens: 30, totalTokens: 230 },
          latencyMs: 1,
        };
      });
    }
    it("creation keys replay the exact receipt, reject changed content and isolate owners", async () => {
      const key = randomUUID(),
        input = {
          title: "Idempotency fixture",
          content: "Content",
          taskType: "Writing" as const,
          requestKey: key,
        };
      const a = await accountContext.run(user, () => createPrompt(input));
      const b = await accountContext.run(user, () => createPrompt(input));
      expect(b.promptId).toBe(a.promptId);
      expect(b.versionId).toBe(a.versionId);
      await expect(
        accountContext.run(user, () => createPrompt({ ...input, content: "changed" })),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      const otherResult = await accountContext.run(other, () => createPrompt(input));
      expect(otherResult.promptId).not.toBe(a.promptId);
      expect(
        (
          await c.query(
            "SELECT count(*) n FROM prompt_creation_requests WHERE owner_user_id=$1 AND request_key=$2",
            [user.id, key],
          )
        ).rows[0].n,
      ).toBe("1");
    });
    it("withdraws only shared eligibility, preserving original private use and immutable history", async () => {
      const importedResult = await offline(user),
        versionId = importedResult.versionId!;
      const submission = await recommendSkill(c, user, versionId);
      await reviewSkill(c, admin, submission.id, "APPROVED", "Reviewed fixture");
      expect((await skillContent(c, other, versionId, true)).accessKind).toBe("LIBRARY");
      await expect(withdrawSkill(c, user, versionId, "forged")).rejects.toMatchObject({
        code: "ADMIN_REQUIRED",
      });
      await withdrawSkill(c, admin, versionId, "Safety fixture");
      await withdrawSkill(c, admin, versionId, "Retry must not overwrite");
      expect((await skillContent(c, user, versionId, true)).accessKind).toBe("PERSONAL");
      await expect(skillContent(c, other, versionId, true)).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND",
      });
      await expect(skillContent(c, admin, versionId, true)).rejects.toMatchObject({
        code: "SKILL_NOT_AVAILABLE",
      });
      expect((await libraryOverview(admin)).history.some((v) => v.versionId === versionId)).toBe(
        true,
      );
      expect((await libraryOverview(other)).library.some((v) => v.versionId === versionId)).toBe(
        false,
      );
      await sqlReject("DELETE FROM skill_library_withdrawals WHERE version_id=$1", [versionId]);
      expect(
        (await c.query("SELECT status FROM skill_library_submissions WHERE id=$1", [submission.id]))
          .rows[0].status,
      ).toBe("APPROVED");
    });
    it("a withdrawn administrator import is review-only even for its publisher", async () => {
      const result = await offline(admin);
      await withdrawSkill(c, admin, result.versionId!, "withdraw");
      expect((await skillContent(c, admin, result.versionId!)).accessKind).toBe("REVIEW_ONLY");
      await expect(loadSkillContext(c, admin, result.versionId!)).rejects.toMatchObject({
        code: "SKILL_NOT_AVAILABLE",
      });
    });
    it("author/upload API uses the existing parser, grants atomically and requires per-request risk", async () => {
      const session = await token(user),
        bundle = syntheticSkill();
      const input = {
        origin: "AUTHORED",
        directoryName: "synthetic-skill",
        files: bundle.files.map((f) => ({
          path: f.path,
          content: Buffer.from(f.bytes).toString("utf8"),
        })),
      };
      expect((await offlinePost(req("/api/skills/offline", session, input))).status).toBe(400);
      const request = req("/api/skills/offline", session, input);
      request.headers.set("idempotency-key", randomUUID());
      request.headers.set("x-personal-risk-acceptance", "personal-risk-v1");
      const response = await offlinePost(request);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("REGISTERED");
      expect((await skillContent(c, user, result.versionId)).accessKind).toBe("PERSONAL");
      await expect(skillContent(c, other, result.versionId)).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND",
      });
      const invalid = req("/api/skills/offline", session, {
        ...input,
        origin: "UPLOAD",
        files: [{ path: "../SKILL.md", content: "bad" }],
      });
      invalid.headers.set("x-personal-risk-acceptance", "personal-risk-v1");
      invalid.headers.set("idempotency-key", randomUUID());
      expect((await offlinePost(invalid)).status).toBe(400);
    });
    it("loads linked resources only, records adoption independently of editable markers and denies forged owners", async () => {
      const bundle = syntheticSkill(
        undefined,
        "[Reference](references/guide.md) [Missing](references/missing.md) [Script](scripts/check.sh)",
      );
      bundle.files.push(
        { path: "references/guide.md", kind: "file", bytes: Buffer.from("REFERENCE METHOD") },
        { path: "scripts/check.sh", kind: "file", bytes: Buffer.from("DO NOT EXECUTE") },
        { path: "assets/unused.txt", kind: "file", bytes: Buffer.from("UNUSED") },
      );
      const result = await registerOfflineSkillInTransaction(c, bundle, randomUUID(), user.id, {
        actor: user,
        riskAccepted: true,
      });
      expect(result.status).toBe("REGISTERED");
      const loaded = await loadSkillContext(c, user, result.versionId!);
      expect(loaded.text).toContain("REFERENCE METHOD");
      expect(loaded.text).not.toContain("DO NOT EXECUTE");
      expect(loaded.text).not.toContain("UNUSED");
      expect(loaded.selection.notes.join(" ")).toContain("Missing relative resource");
      const event = await skillContent(c, user, result.versionId!, true);
      const saved = await accountContext.run(user, () =>
        createPrompt({
          title: "No editable source marker",
          taskType: "Writing",
          content: "Edited draft",
          manualDraft: true,
          adoptedUseEventIds: [event.useEventId!],
        }),
      );
      const evidence = (
        await c.query("SELECT * FROM prompt_skill_sources WHERE prompt_version_id=$1", [
          saved.versionId,
        ])
      ).rows[0];
      expect(evidence.skill_version_id).toBe(result.versionId);
      expect(evidence.resources).toHaveLength(2);
      expect(
        (
          await provenanceGet(
            req(`/api/skills/provenance?versionId=${saved.versionId}`, await token(other)),
          )
        ).status,
      ).toBe(404);
      await expect(
        accountContext.run(other, () =>
          createPrompt({
            title: "Forged",
            taskType: "Writing",
            content: "x",
            adoptedUseEventIds: [event.useEventId!],
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_SKILL_ADOPTION" });
      await sqlReject(
        "UPDATE prompt_skill_sources SET manifest_sha256='forged' WHERE prompt_version_id=$1",
        [saved.versionId],
      );
    });
    it("serves exact paginated totals and escaped search rather than a capped count", async () => {
      const result = await offline(user);
      const all = await libraryOverview(user, 1, "synthetic");
      expect(all.totals.personal).toBe(1);
      expect(all.personal[0].versionId).toBe(result.versionId);
      expect((await libraryOverview(user, 1, "%")).personal).toHaveLength(0);
      expect((await libraryOverview(user, 2, "synthetic")).personal).toHaveLength(0);
    });
    it("runs a real DB/Model Service/quota path with a mocked provider, binds provenance and applies optimization as a new version", async () => {
      configureSyntheticModel();
      const importedResult = await offline(user);
      await accountContext.run(user, async () => {
        const plan = await createSkillPlan({
          goal: "Plan implementation and verification",
          taskType: "Coding",
          locale: "en",
          matchingMode: "MANUAL",
          selectedVersionIds: [importedResult.versionId!],
        });
        const key = randomUUID();
        const generated = await runSkillPlan(
          { planId: plan.id, purpose: "PROMPT_GENERATION" },
          key,
        );
        expect(generated.status).toBe("SUCCEEDED");
        const result = generated.result as { promptId: string; versionId: string };
        expect(
          (await runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key)).status,
        ).toBe("SUCCEEDED");
        expect(generateWithDeepSeek).toHaveBeenCalledTimes(1);
        const call = vi.mocked(generateWithDeepSeek).mock.calls[0];
        expect(call[1].skillContext).toContain("Use explicit inputs");
        const execution = (
          await c.query(
            "SELECT per_attempt_tokens,total_tokens,quota_reservation_status FROM model_executions WHERE id=$1",
            [(generated.result as { executionId: string }).executionId],
          )
        ).rows[0];
        expect(Number(execution.per_attempt_tokens)).toBeGreaterThan(200);
        expect(Number(execution.total_tokens)).toBe(230);
        expect(execution.quota_reservation_status).toBe("SETTLED");
        const optimized = await runSkillPlan(
          {
            planId: plan.id,
            purpose: "OPTIMIZATION",
            promptId: result.promptId,
            versionId: result.versionId,
          },
          randomUUID(),
        );
        expect(optimized.status).toBe("SUCCEEDED");
        const proposal = optimized.result as { content: string; optimizationId: string };
        expect(
          (
            await c.query(
              "SELECT current_version_id FROM prompts WHERE id=$1 AND owner_user_id=$2",
              [result.promptId, user.id],
            )
          ).rows[0].current_version_id,
        ).toBe(result.versionId);
        const applied = await createPromptVersion({
          promptId: result.promptId,
          baseVersionId: result.versionId,
          content: proposal.content,
          source: "SKILL_LIVE_OPTIMIZATION",
          optimizationId: proposal.optimizationId,
        });
        expect(applied!.number).toBe(2);
        const replay = await createPromptVersion({
          promptId: result.promptId,
          baseVersionId: result.versionId,
          content: proposal.content,
          source: "SKILL_LIVE_OPTIMIZATION",
          optimizationId: proposal.optimizationId,
        });
        expect(replay!.versionId).toBe(applied!.versionId);
        const sources = await c.query(
          "SELECT prompt_version_id,evidence_kind,plan_id FROM prompt_skill_sources WHERE owner_user_id=$1 AND skill_version_id=$2",
          [user.id, importedResult.versionId],
        );
        expect(sources.rows).toHaveLength(2);
        expect(
          sources.rows.every((s) => s.evidence_kind === "MODEL_CONTEXT" && s.plan_id === plan.id),
        ).toBe(true);
        await sqlReject("UPDATE skill_workflow_plans SET goal='forged' WHERE id=$1", [plan.id]);
        await expect(
          accountContext.run(other, () => loadWorkflowContext(c, plan.id)),
        ).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
      });
    });
    it("matches only published shared versions automatically and keeps explicit private selections owner-scoped", async () => {
      const privateSkill = await offline(user, "Private method"),
        sharedSkill = await offline(admin, "Shared method");
      const goal = "project owned offline fixture";
      await accountContext.run(user, async () => {
        const automatic = await createSkillPlan({
          goal,
          taskType: "General",
          locale: "en",
          matchingMode: "AUTO",
          selectedVersionIds: [],
        });
        expect(automatic.selections.map((s) => s.versionId)).toEqual([sharedSkill.versionId]);
        expect(automatic.analysis.matching.candidates.map((s) => s.versionId)).not.toContain(
          privateSkill.versionId,
        );
        for (const matchingMode of ["MANUAL", "HYBRID"] as const) {
          const manual = await createSkillPlan({
            goal,
            taskType: "General",
            locale: "en",
            matchingMode,
            selectedVersionIds: [privateSkill.versionId!],
            manualOverride: true,
          });
          expect(manual.selections.map((s) => s.versionId)).toEqual([privateSkill.versionId]);
        }
        const excluded = await createSkillPlan({
          goal,
          taskType: "General",
          locale: "en",
          matchingMode: "MANUAL",
          selectedVersionIds: [],
          manualOverride: true,
        });
        expect(excluded.selections).toEqual([]);
        expect(excluded.analysis.matching.manualOverride).toBe(true);
        expect((await loadWorkflowContext(c, excluded.id)).text).toBeUndefined();
      });
      await expect(
        accountContext.run(other, () =>
          createSkillPlan({
            goal,
            taskType: "General",
            locale: "en",
            matchingMode: "MANUAL",
            selectedVersionIds: [privateSkill.versionId!],
          }),
        ),
      ).rejects.toMatchObject({ code: "SKILL_NOT_AVAILABLE" });
      await withdrawSkill(c, admin, sharedSkill.versionId!, "Synthetic withdrawal");
      expect(
        (
          await accountContext.run(other, () =>
            createSkillPlan({
              goal,
              taskType: "General",
              locale: "en",
              matchingMode: "AUTO",
              selectedVersionIds: [],
            }),
          )
        ).selections,
      ).toEqual([]);
    });
    it("dispatches no Skill material for explicit exclusion, persists descriptors separately, and reconciles the same key", async () => {
      configureSyntheticModel();
      await accountContext.run(user, async () => {
        const descriptor = { purposes: ["create" as const], tags: ["PRIVATE_WORKFLOW_DESCRIPTOR"] };
        const plan = await createSkillPlan({
          goal: "Return one greeting",
          taskType: "General",
          locale: "en",
          matchingMode: "MANUAL",
          selectedVersionIds: [],
          manualOverride: true,
          descriptor,
        });
        expect(plan.analysis.descriptor).toEqual(descriptor);
        expect(plan.analysis.contextVersion).toBe("on-demand-v1");
        const key = randomUUID(),
          result = await runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key);
        expect(result.status).toBe("SUCCEEDED");
        const call = vi.mocked(generateWithDeepSeek).mock.calls[0];
        expect(call[1].skillContext).toBeUndefined();
        expect(call[1].taskPlanContext).toBeUndefined();
        const messages = JSON.stringify(call[2]?.messages);
        expect(messages).not.toContain("PRIVATE_WORKFLOW_DESCRIPTOR");
        expect(messages).not.toContain("UNTRUSTED SKILL MATERIALS");
        expect((await getPromptForEvaluation(result.result.promptId))?.descriptor).toEqual(
          descriptor,
        );
        expect((await skillWorkflowStatus(key)).status).toBe("SUCCEEDED");
        await runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key);
        expect(generateWithDeepSeek).toHaveBeenCalledTimes(1);
      });
    });
    it("saves edited purposes atomically and preserves them through subsequent optimization and historical restore", async () => {
      await accountContext.run(user, async () => {
        const created = await createPrompt({
          title: "Editable metadata",
          taskType: "Writing",
          content: "Original",
        });
        const descriptor = { purposes: ["analyze" as const, "plan" as const], tags: ["经营复盘"] };
        const edited = await createPromptVersion({
          promptId: created.promptId,
          baseVersionId: created.versionId,
          source: "Edited",
          content: "Analyze the data",
          descriptor,
        });
        expect((await getPromptForEvaluation(created.promptId))?.descriptor).toEqual(descriptor);
        const preview = await saveOptimization({
          promptId: created.promptId,
          sourceVersionId: edited!.versionId,
          proposedContent: "Analyze with better checks",
        });
        expect(preview).toBe(true);
        const proposalId = (
          await c.query(
            "SELECT id FROM optimization_records WHERE prompt_id=$1 AND owner_user_id=$2 AND source_prompt_version_id=$3",
            [created.promptId, user.id, edited!.versionId],
          )
        ).rows[0].id;
        expect((await getPromptForEvaluation(created.promptId))?.descriptor).toEqual(descriptor);
        const optimized = await createPromptVersion({
          promptId: created.promptId,
          baseVersionId: edited!.versionId,
          optimizationId: proposalId,
          source: "Optimized",
          content: "Analyze with better checks",
        });
        expect((await getPromptForEvaluation(created.promptId))?.descriptor).toEqual(descriptor);
        const restored = await createPromptVersion({
          promptId: created.promptId,
          baseVersionId: optimized!.versionId,
          parentVersionId: created.versionId,
          source: "Restored",
          content: "Original",
        });
        expect((await getPromptForEvaluation(created.promptId))?.descriptor).toEqual(descriptor);
        expect((await getPromptForEvaluation(created.promptId))?.taskType).toBe("Writing");
        await expect(
          createPromptVersion({
            promptId: created.promptId,
            baseVersionId: created.versionId,
            source: "Conflict",
            content: "Lost",
            descriptor: { purposes: [], tags: [] },
          }),
        ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
        expect((await getPromptForEvaluation(created.promptId))?.descriptor).toEqual(descriptor);
        await createPromptVersion({
          promptId: created.promptId,
          baseVersionId: restored!.versionId,
          source: "Clear",
          content: "Original",
          descriptor: { purposes: [], tags: [] },
        });
        expect((await getPromptForEvaluation(created.promptId))?.descriptor).toEqual({
          purposes: [],
          tags: [],
        });
      });
    });
    it("validates version descriptors at the API boundary without granting another owner access", async () => {
      const created = await accountContext.run(user, () =>
        createPrompt({ title: "Metadata API", taskType: "General", content: "Original" }),
      );
      const body = {
        content: "New",
        baseVersionId: created.versionId,
        source: "Edited",
        descriptor: { purposes: ["analyze"], tags: ["API"] },
      };
      const context = { params: Promise.resolve({ promptId: created.promptId }) };
      const session = await token(user);
      const wrong = await versionPost(
        req(`/api/prompts/${created.promptId}/versions`, session, {
          ...body,
          descriptor: { purposes: ["invalid"], tags: [] },
        }),
        context,
      );
      expect(wrong.status).toBe(400);
      const foreign = await versionPost(
        req(`/api/prompts/${created.promptId}/versions`, await token(other), body),
        context,
      );
      expect(foreign.status).toBe(404);
      const result = await versionPost(
        req(`/api/prompts/${created.promptId}/versions`, session, body),
        context,
      );
      expect(result.status).toBe(201);
      expect(
        (await accountContext.run(user, () => getPromptForEvaluation(created.promptId)))
          ?.descriptor,
      ).toEqual(body.descriptor);
    });
    it("retains stage package instructions with zero Skills without labeling a method reference", async () => {
      configureSyntheticModel();
      await accountContext.run(user, async () => {
        const plan = await createSkillPlan({
          goal: "First produce a schema, then implement a client using the previous schema",
          taskType: "Coding",
          locale: "en",
          matchingMode: "MANUAL",
          selectedVersionIds: [],
          deliveryPreference: "PROMPT_PACKAGE",
        });
        const generated = await runSkillPlan(
          { planId: plan.id, purpose: "PROMPT_GENERATION" },
          randomUUID(),
        );
        expect(generated.status).toBe("SUCCEEDED");
        const call = vi.mocked(generateWithDeepSeek).mock.calls[0];
        expect(call[1].skillContext).toBeUndefined();
        expect(call[1].taskPlanContext).toContain('"delivery":"PROMPT_PACKAGE"');
        expect(JSON.stringify(call[2]?.messages)).toContain("TASK DELIVERY PLAN");
        expect(JSON.stringify(call[2]?.messages)).not.toContain("UNTRUSTED SKILL MATERIALS");
      });
    });
    it("plans an owned long optimization source by reference without truncation, duplicate provider text, or implicit Apply", async () => {
      configureSyntheticModel();
      const longContent =
        "Return JSON preserving 500 USD. " +
        "User material ".repeat(2000) +
        "Keep final constraint.";
      const created = await accountContext.run(user, () =>
        createPrompt({ title: "Long existing prompt", taskType: "Writing", content: longContent }),
      );
      const skill = await offline(user);
      const source = { promptId: created.promptId, versionId: created.versionId };
      const session = await token(user);
      const response = await workflowPost(
        req("/api/skills/workflow", session, {
          action: "plan",
          source,
          locale: "en",
          matchingMode: "MANUAL",
          selectedVersionIds: [skill.versionId],
        }),
      );
      expect(response.status).toBe(200);
      const plan = await response.json();
      expect(plan.analysis.goal).toBe(longContent);
      expect(plan.analysis.taskType).toBe("Writing");
      expect(plan.analysis.source).toEqual(source);
      await accountContext.run(user, async () => {
        const context = await loadWorkflowContext(c, plan.id);
        expect(context.goal).toBe(longContent);
        expect(context.text).not.toContain(longContent);
        const optimized = await runSkillPlan(
          { planId: plan.id, purpose: "OPTIMIZATION", ...source },
          randomUUID(),
        );
        expect(optimized.status, JSON.stringify(optimized)).toBe("SUCCEEDED");
        const messages = JSON.stringify(vi.mocked(generateWithDeepSeek).mock.calls[0][2]?.messages);
        expect(messages.split(longContent).length - 1).toBe(1);
        expect((await getPromptForEvaluation(created.promptId))?.currentVersionId).toBe(
          created.versionId,
        );
        await expect(
          runSkillPlan(
            {
              planId: plan.id,
              purpose: "OPTIMIZATION",
              promptId: source.promptId,
              versionId: "mismatched-version",
            },
            randomUUID(),
          ),
        ).rejects.toMatchObject({ code: "PLAN_SOURCE_MISMATCH" });
        expect(generateWithDeepSeek).toHaveBeenCalledTimes(1);
      });
      await expect(
        accountContext.run(other, () =>
          createSkillPlan({
            source,
            taskType: "General",
            locale: "en",
            matchingMode: "MANUAL",
            selectedVersionIds: [],
          }),
        ),
      ).rejects.toMatchObject({ code: "PROMPT_VERSION_NOT_FOUND" });
    });
    it("withdrawal blocks a locked plan and model failure remains failed on key replay", async () => {
      configureSyntheticModel();
      const importedResult = await offline(admin);
      const plan = await accountContext.run(user, () =>
        createSkillPlan({
          goal: "write",
          taskType: "Writing",
          locale: "en",
          matchingMode: "MANUAL",
          selectedVersionIds: [importedResult.versionId!],
        }),
      );
      vi.mocked(generateWithDeepSeek).mockRejectedValueOnce(
        new ModelServiceError("SYNTHETIC_PROVIDER_FAILURE", "Synthetic only", 503),
      );
      const key = randomUUID();
      const failed = await accountContext.run(user, () =>
        runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key),
      );
      expect(failed.status).toBe("FAILED");
      const again = await accountContext.run(user, () =>
        runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key),
      );
      expect(again.status).toBe("FAILED");
      expect(generateWithDeepSeek).toHaveBeenCalledTimes(1);
      await withdrawSkill(c, admin, importedResult.versionId!, "safety");
      await expect(
        accountContext.run(user, () => loadWorkflowContext(c, plan.id)),
      ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
      await expect(
        accountContext.run(user, () =>
          runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, randomUUID()),
        ),
      ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
      expect(generateWithDeepSeek).toHaveBeenCalledTimes(1);
    });
    it("recovers a model success after workflow receipt interruption without another provider attempt", async () => {
      configureSyntheticModel();
      await accountContext.run(user, async () => {
        const plan = await createSkillPlan({
          goal: "Write clearly",
          taskType: "Writing",
          locale: "en",
          matchingMode: "MANUAL",
          selectedVersionIds: [],
        });
        const key = randomUUID(),
          id = `swr_${randomUUID()}`;
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              planId: plan.id,
              purpose: "PROMPT_GENERATION",
              promptId: null,
              versionId: null,
            }),
          )
          .digest("hex");
        await c.query(
          "INSERT INTO skill_workflow_runs(id,owner_user_id,request_key,payload_sha256,plan_id,status) VALUES($1,$2,$3,$4,$5,'RUNNING')",
          [id, user.id, key, fingerprint, plan.id],
        );
        const result = await generateLivePrompt({
          goal: "Write clearly",
          taskType: "Writing",
          locale: "en",
          skillPlanId: plan.id,
          skillRunId: id,
        });
        expect((await skillWorkflowStatus(key)).status).toBe("SUCCEEDED");
        const replay = await runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key);
        expect(replay.result.promptId).toBe(result.promptId);
        expect(generateWithDeepSeek).toHaveBeenCalledTimes(1);
      });
    });
    it("records cancellation with held unknown costs and never redispatches its key", async () => {
      configureSyntheticModel();
      vi.mocked(generateWithDeepSeek).mockImplementationOnce(async (_c, _i, hooks) => {
        await hooks?.beforeAttempt?.();
        throw new ModelServiceError("MODEL_REQUEST_CANCELLED", "Synthetic cancellation", 408);
      });
      await accountContext.run(user, async () => {
        const plan = await createSkillPlan({
            goal: "write",
            taskType: "Writing",
            locale: "en",
            matchingMode: "MANUAL",
            selectedVersionIds: [],
          }),
          key = randomUUID();
        const failed = await runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key);
        expect(failed.status).toBe("FAILED");
        const row = (
          await c.query(
            "SELECT quota_reservation_status,reconciliation_status FROM model_executions WHERE id=$1",
            [failed.result.executionId],
          )
        ).rows[0];
        expect(row).toEqual({
          quota_reservation_status: "HELD",
          reconciliation_status: "REQUIRED",
        });
        await runSkillPlan({ planId: plan.id, purpose: "PROMPT_GENERATION" }, key);
        expect(generateWithDeepSeek).toHaveBeenCalledTimes(1);
      });
    });
    it("rejects raw client context, forged candidate access, and an oversized selection before models", async () => {
      const privateSkill = await offline(other),
        session = await token(user);
      const input = {
        action: "plan",
        goal: "Plan",
        taskType: "Writing",
        locale: "en",
        matchingMode: "MANUAL",
        selectedVersionIds: [privateSkill.versionId],
      };
      expect(
        (
          await workflowPost(
            req("/api/skills/workflow", session, { ...input, skillContext: "FORGED" }),
          )
        ).status,
      ).toBe(400);
      expect((await workflowPost(req("/api/skills/workflow", session, input))).status).toBe(403);
      expect(
        (
          await workflowPost(
            req("/api/skills/workflow", session, {
              ...input,
              selectedVersionIds: Array(5).fill(privateSkill.versionId),
            }),
          )
        ).status,
      ).toBe(400);
      expect(generateWithDeepSeek).not.toHaveBeenCalled();
    });
    it("an expired prepared source still reconciles its terminal import, without fetching again", async () => {
      const id = `sps_${randomUUID()}`,
        approval = { ...fixtureApproval, approvalId: id };
      await c.query(
        "INSERT INTO skill_prepared_sources(id,owner_user_id,approval,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",
        [id, user.id, JSON.stringify(approval)],
      );
      const key = randomUUID(),
        work = await beginGithubImportInTransaction(c, user.id, fixtureInput, key, [approval]),
        bundle = githubFixture().bundle;
      bundle.source.approvalId = id;
      const registered = await completeGithubImportInTransaction(c, user.id, work, bundle, {
        actor: user,
        riskAccepted: true,
      });
      expect(registered.status).toBe("REGISTERED");
      const request = req("/api/skills/imports", await token(user), { preparedSourceId: id });
      request.headers.set("idempotency-key", key);
      request.headers.set("x-personal-risk-acceptance", "personal-risk-v1");
      const result = await importPost(request);
      expect(result.status).toBe(200);
      expect((await result.json()).versionId).toBe(registered.versionId);
      expect(fetchGithubSkill).not.toHaveBeenCalled();
    });
    it("stores role accounts separately, enforces unique identities and rejects client role injection", async () => {
      expect(
        (
          await c.query("SELECT email,password_hash FROM administrator_users WHERE user_id=$1", [
            admin.id,
          ])
        ).rows[0],
      ).toEqual({ email: admin.email, password_hash: encoded });
      expect(
        (await c.query("SELECT user_id FROM regular_users WHERE user_id=$1", [admin.id])).rowCount,
      ).toBe(0);
      await sqlReject("INSERT INTO regular_users(user_id,email,password_hash) VALUES($1,$2,$3)", [
        admin.id,
        admin.email,
        encoded,
      ]);
      await sqlReject("INSERT INTO app_users(id,identity_key,account_kind) VALUES($1,$2,'USER')", [
        randomUUID(),
        `email:${admin.email}`,
      ]);
      expect(() => credentials({ email: user.email, password, role: "ADMIN" })).toThrow(
        "INVALID_CREDENTIALS",
      );
      expect(await verifyPassword(password, encoded)).toBe(true);
      expect(await verifyPassword("incorrect-password", encoded)).toBe(false);
    });
    it("authenticates accounts, hides wrong credentials, hashes session tokens, rotates and revokes", async () => {
      expect(await authenticate({ email: user.email.toUpperCase(), password })).toEqual(user);
      await expect(
        authenticate({ email: user.email, password: "incorrect-password" }),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      const first = await token(user);
      const rows = (
        await c.query("SELECT token_hash FROM account_sessions WHERE user_id=$1", [user.id])
      ).rows;
      expect(rows[0].token_hash).toBe(createHash("sha256").update(first).digest("hex"));
      expect(rows[0].token_hash).not.toBe(first);
      expect(await sessionActor(req("/api/auth/session", first))).toEqual(user);
      const next = await createSession(user, first);
      await expect(sessionActor(req("/api/auth/session", first))).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      await logout(req("/api/auth/logout", next, {}));
      await expect(sessionActor(req("/api/auth/session", next))).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
    });
    it("rejects expired and disabled sessions without falling back to demo identity", async () => {
      const s = await token(user);
      await c.query(
        "UPDATE account_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
        [user.id],
      );
      expect((await snapshotGet(req("/api/demo/snapshot", s))).status).toBe(401);
      const active = await token(user);
      await c.query("UPDATE regular_users SET disabled=true WHERE user_id=$1", [user.id]);
      expect((await libraryGet(req("/api/skills/library", active))).status).toBe(401);
      expect((await libraryGet(req("/api/skills/library"))).status).toBe(401);
    });
    it("persists failed-login throttling", async () => {
      for (let i = 0; i < 8; i++)
        await expect(
          authenticate({ email: user.email, password: "wrong-password" }),
        ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      await expect(authenticate({ email: user.email, password })).rejects.toMatchObject({
        code: "TOO_MANY_ATTEMPTS",
      });
    });
    it("isolates parallel request identities and real workspace records", async () => {
      const a = await token(user),
        b = await token(other);
      const created = await promptPost(
        req("/api/prompts", a, {
          title: "Private prompt",
          taskType: "Writing",
          content: "PRIVATE_SYNTHETIC_CONTENT",
        }),
      );
      expect(created.status).toBe(201);
      // Read the test transaction's uncommitted rows through its own connection.
      const l = await accountContext.run(user, () => getSnapshot(c));
      const r = await accountContext.run(other, () => getSnapshot(c));
      expect(l.prompts).toHaveLength(1);
      expect(r.prompts).toHaveLength(0);
      const identities = await Promise.all([
        accountContext.run(user, async () => {
          await Promise.resolve();
          return workspaceOwnerId();
        }),
        accountContext.run(other, async () => {
          await Promise.resolve();
          return workspaceOwnerId();
        }),
      ]);
      expect(identities).toEqual([user.id, other.id]);
      expect((await sessionActor(req("/api/auth/session", b)))?.id).toBe(other.id);
      expect(JSON.stringify(r)).not.toContain("PRIVATE_SYNTHETIC_CONTENT");
      expect(() => workspaceOwnerId()).toThrow("AUTH_REQUIRED");
    });
    it("personal imports are usable by owner and invisible to other users and uninvited reviewers", async () => {
      const result = await imported(user);
      expect((await skillContent(c, user, result.versionId!, true)).accessKind).toBe("PERSONAL");
      await expect(skillContent(c, other, result.versionId!)).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND",
      });
      await expect(skillContent(c, admin, result.versionId!)).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND",
      });
      expect(
        (await libraryOverview(other)).library.some((x) => x.versionId === result.versionId),
      ).toBe(false);
      const s = await token(other);
      expect(
        (
          await jobGet(req(`/api/skills/imports/${result.jobId}`, s), {
            params: Promise.resolve({ jobId: result.jobId }),
          })
        ).status,
      ).toBe(404);
    });
    it("requires risk acceptance before an ordinary import dispatches network", async () => {
      await expect(
        accountContext.run(user, () =>
          importGithubSkill(fixtureInput, "no-risk", undefined, false, [fixtureApproval]),
        ),
      ).rejects.toMatchObject({ code: "PERSONAL_RISK_ACCEPTANCE_REQUIRED" });
      expect(fetchGithubSkill).not.toHaveBeenCalled();
      expect(
        (await c.query("SELECT id FROM skill_import_jobs WHERE owner_user_id=$1", [user.id]))
          .rowCount,
      ).toBe(0);
    });
    it("admin imports publish directly, require no submission, and are usable by ordinary users", async () => {
      const result = await imported(admin);
      expect(
        (
          await c.query("SELECT publication_kind FROM skill_library_entries WHERE version_id=$1", [
            result.versionId,
          ])
        ).rows[0].publication_kind,
      ).toBe("ADMIN_IMPORT");
      expect(
        (
          await c.query("SELECT id FROM skill_library_submissions WHERE version_id=$1", [
            result.versionId,
          ])
        ).rowCount,
      ).toBe(0);
      expect((await skillContent(c, other, result.versionId!, true)).accessKind).toBe("LIBRARY");
      expect(
        (await c.query("SELECT enabled FROM skills WHERE owner_user_id=$1", [admin.id])).rows[0]
          .enabled,
      ).toBe(false);
    });
    it("recommendation grants review-only access, and approval atomically publishes the exact version", async () => {
      const result = await imported(user);
      const sub = await recommendSkill(c, user, result.versionId!);
      expect(await recommendSkill(c, user, result.versionId!)).toEqual(sub);
      expect((await skillContent(c, admin, result.versionId!)).accessKind).toBe("REVIEW_ONLY");
      await expect(skillContent(c, admin, result.versionId!, true)).rejects.toMatchObject({
        code: "SKILL_NOT_AVAILABLE",
      });
      await expect(reviewSkill(c, user, sub.id, "APPROVED", "forged")).rejects.toMatchObject({
        code: "ADMIN_REQUIRED",
      });
      await reviewSkill(
        c,
        admin,
        sub.id,
        "APPROVED",
        "Reviewed exact text, license and dependencies.",
      );
      expect((await skillContent(c, other, result.versionId!, true)).accessKind).toBe("LIBRARY");
      expect(
        await reviewSkill(
          c,
          admin,
          sub.id,
          "APPROVED",
          "Reviewed exact text, license and dependencies.",
        ),
      ).toEqual({ id: sub.id, status: "APPROVED" });
      await expect(
        reviewSkill(c, admin, sub.id, "REJECTED", "Changed decision"),
      ).rejects.toMatchObject({ code: "REVIEW_ALREADY_DECIDED" });
      const next = await imported(user, "# New unreviewed version\n");
      await expect(skillContent(c, other, next.versionId!)).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND",
      });
    });
    it("rejection leaves the user's personal access intact and never publishes", async () => {
      const result = await imported(user);
      const sub = await recommendSkill(c, user, result.versionId!);
      await reviewSkill(c, admin, sub.id, "REJECTED", "Unresolved external dependencies.");
      expect((await skillContent(c, user, result.versionId!, true)).accessKind).toBe("PERSONAL");
      await expect(skillContent(c, other, result.versionId!)).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND",
      });
    });
    it("prevents forged publication and immutable review/history mutation in PostgreSQL", async () => {
      const result = await imported(user);
      await sqlReject(
        "INSERT INTO skill_library_entries(version_id,publisher_id,publication_kind) VALUES($1,$2,'ADMIN_IMPORT')",
        [result.versionId, admin.id],
      );
      await sqlReject(
        "INSERT INTO skill_library_entries(version_id,publisher_id,publication_kind) VALUES($1,$2,'ADMIN_IMPORT')",
        [result.versionId, user.id],
      );
      const sub = await recommendSkill(c, user, result.versionId!);
      await reviewSkill(c, admin, sub.id, "APPROVED", "verified");
      await sqlReject("UPDATE skill_library_submissions SET status='REJECTED' WHERE id=$1", [
        sub.id,
      ]);
      await sqlReject("DELETE FROM skill_library_entries WHERE version_id=$1", [result.versionId]);
      await sqlReject("DELETE FROM skill_personal_access WHERE version_id=$1", [result.versionId]);
    });
    it("counts failed source preparations and blocks requests beyond the owner window", async () => {
      const u = await token(user);
      vi.mocked(inspectGithubSource).mockRejectedValue(
        new SkillInputError("GITHUB_LICENSE_MISSING"),
      );
      for (let i = 0; i < 20; i++)
        expect((await sourcePost(req("/api/skills/sources", u, fixtureInput))).status).toBe(400);
      expect((await sourcePost(req("/api/skills/sources", u, fixtureInput))).status).toBe(429);
      expect(inspectGithubSource).toHaveBeenCalledTimes(20);
      expect(
        (
          await c.query(
            "SELECT attempts FROM skill_source_preparation_limits WHERE owner_user_id=$1",
            [user.id],
          )
        ).rows[0].attempts,
      ).toBe(21);
      expect(
        (await c.query("SELECT id FROM skill_prepared_sources WHERE owner_user_id=$1", [user.id]))
          .rowCount,
      ).toBe(0);
    });
    it("reports offline same-version reuse truthfully across new keys and receipt recovery", async () => {
      const bundle = syntheticSkill(),
        key = randomUUID();
      const first = await registerOfflineSkillInTransaction(c, bundle, key, user.id, {
        actor: user,
        riskAccepted: true,
      });
      expect(first.reusedVersion).toBe(false);
      expect(
        await registerOfflineSkillInTransaction(c, bundle, key, user.id, {
          actor: user,
          riskAccepted: true,
        }),
      ).toEqual(first);
      const duplicateKey = randomUUID();
      const duplicate = await registerOfflineSkillInTransaction(c, bundle, duplicateKey, user.id, {
        actor: user,
        riskAccepted: true,
      });
      expect(duplicate).toMatchObject({ versionId: first.versionId, reusedVersion: true });
      expect(
        await registerOfflineSkillInTransaction(c, bundle, duplicateKey, user.id, {
          actor: user,
          riskAccepted: true,
        }),
      ).toEqual(duplicate);
      const changed = await registerOfflineSkillInTransaction(
        c,
        syntheticSkill(undefined, "New body requiring separate review"),
        randomUUID(),
        user.id,
        { actor: user, riskAccepted: true },
      );
      expect(changed.reusedVersion).toBe(false);
      expect(changed.versionId).not.toBe(first.versionId);
    });
    it("reports GitHub reused-version identity for import, key replay and owner-scoped job recovery", async () => {
      const first = await imported(user);
      expect(first.reusedVersion).toBe(false);
      const duplicateKey = randomUUID();
      const work = await beginGithubImportInTransaction(c, user.id, fixtureInput, duplicateKey, [
        fixtureApproval,
      ]);
      const duplicate = await completeGithubImportInTransaction(
        c,
        user.id,
        work,
        githubFixture().bundle,
        { actor: user, riskAccepted: true },
      );
      expect(duplicate).toMatchObject({ versionId: first.versionId, reusedVersion: true });
      expect(
        (
          await beginGithubImportInTransaction(c, user.id, fixtureInput, duplicateKey, [
            fixtureApproval,
          ])
        ).result,
      ).toEqual(duplicate);
      const session = await token(user),
        denied = await token(other);
      const response = await jobGet(req(`/api/skills/imports/${duplicate.jobId}`, session), {
        params: Promise.resolve({ jobId: duplicate.jobId }),
      });
      expect(await response.json()).toMatchObject({
        versionId: first.versionId,
        reusedVersion: true,
      });
      expect(
        (
          await jobGet(req(`/api/skills/imports/${duplicate.jobId}`, denied), {
            params: Promise.resolve({ jobId: duplicate.jobId }),
          })
        ).status,
      ).toBe(404);
    });
    it("previews same and changed versions without leaking another owner's source installation", async () => {
      vi.mocked(inspectGithubSource).mockResolvedValue(fixtureApproval);
      const bundle = githubFixture().bundle;
      vi.mocked(fetchGithubSkill).mockResolvedValue(bundle);
      const session = await token(user),
        otherSession = await token(other);
      async function preview(sessionToken: string) {
        const request = req("/api/skills/sources", sessionToken, fixtureInput);
        request.headers.set("x-skill-preview", "true");
        const response = await sourcePost(request);
        expect(response.status).toBe(200);
        return (await response.json()).preview;
      }
      expect(await preview(session)).toMatchObject({ importState: "NEW_SKILL" });
      const first = await imported(user);
      const same = await preview(session);
      expect(same).toMatchObject({
        importState: "SAME_VERSION",
        existingVersionId: first.versionId,
        manifestSha256: first.manifestSha256,
      });
      const privateOther = await preview(otherSession);
      expect(privateOther.importState).toBe("NEW_SKILL");
      expect(privateOther.existingVersionId).toBeUndefined();
      vi.mocked(fetchGithubSkill).mockResolvedValue(
        githubFixture("New body requiring review").bundle,
      );
      const changed = await preview(session);
      expect(changed.importState).toBe("NEW_VERSION");
      expect(changed.existingVersionId).toBeUndefined();
      expect(
        (await c.query("SELECT count(*) FROM skill_versions WHERE owner_user_id=$1", [user.id]))
          .rows[0].count,
      ).toBe("1");
    });
    it("prepared sources are private, expiring and grant ordinary personal access only", async () => {
      const u = await token(user),
        o = await token(other);
      vi.mocked(inspectGithubSource).mockResolvedValue(fixtureApproval);
      const prepared = await sourcePost(req("/api/skills/sources", u, fixtureInput));
      expect(prepared.status).toBe(200);
      const { preparedSourceId } = await prepared.json();
      expect((await importPost(req("/api/skills/imports", o, { preparedSourceId }))).status).toBe(
        400,
      );
      expect(fetchGithubSkill).not.toHaveBeenCalled();
      vi.mocked(fetchGithubSkill).mockResolvedValue(githubFixture().bundle);
      const request = req("/api/skills/imports", u, { preparedSourceId });
      request.headers.set("idempotency-key", randomUUID());
      request.headers.set("x-personal-risk-acceptance", "personal-risk-v1");
      const importedResponse = await importPost(request);
      expect(importedResponse.status).toBe(200);
      const result = await importedResponse.json();
      expect(result.status).toBe("REGISTERED");
      expect((await skillContent(c, user, result.versionId)).accessKind).toBe("PERSONAL");
      await expect(skillContent(c, other, result.versionId)).rejects.toMatchObject({
        code: "SKILL_NOT_FOUND",
      });
      const expired = `sps_${randomUUID()}`;
      await c.query(
        "INSERT INTO skill_prepared_sources(id,owner_user_id,approval,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 second')",
        [expired, user.id, JSON.stringify(fixtureApproval)],
      );
      expect(
        (await importPost(req("/api/skills/imports", u, { preparedSourceId: expired }))).status,
      ).toBe(400);
    });
    it("manual draft saving records honest provenance under the authenticated owner", async () => {
      const s = await token(user);
      const r = await promptPost(
        req("/api/prompts", s, {
          title: "Manual fixture",
          taskType: "Writing",
          content: "ADOPTED_TEXT",
          manualDraft: true,
        }),
      );
      expect(r.status).toBe(201);
      const result = await r.json();
      expect(
        (
          await c.query("SELECT source,owner_user_id FROM prompt_versions WHERE id=$1", [
            result.versionId,
          ])
        ).rows[0],
      ).toEqual({ source: "MANUAL_DRAFT", owner_user_id: user.id });
      expect(
        (await c.query("SELECT source FROM history_records WHERE prompt_id=$1", [result.promptId]))
          .rows[0].source,
      ).toBe("MANUAL_DRAFT");
    });
    it("API guards enforce admin role, share consent, exact keys, CSRF and owner isolation", async () => {
      const result = await imported(user);
      const a = await token(admin),
        u = await token(user),
        o = await token(other);
      expect((await accountsGet(req("/api/accounts", u))).status).toBe(403);
      const list = await accountsGet(req("/api/accounts", a));
      expect(list.status).toBe(200);
      expect(await list.text()).not.toContain("password_hash");
      expect(
        (
          await libraryPost(
            req("/api/skills/library", u, {
              action: "recommend",
              versionId: result.versionId,
              shareAccepted: false,
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await libraryPost(
            req("/api/skills/library", o, {
              action: "recommend",
              versionId: result.versionId,
              shareAccepted: true,
            }),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await libraryPost(
            req("/api/skills/library", u, {
              action: "use",
              versionId: result.versionId,
              ownerId: other.id,
            }),
          )
        ).status,
      ).toBe(400);
      const cross = req("/api/skills/library", u, { action: "use", versionId: result.versionId });
      cross.headers.set("origin", "http://evil.test");
      expect((await libraryPost(cross)).status).toBe(403);
      const sub = await libraryPost(
        req("/api/skills/library", u, {
          action: "recommend",
          versionId: result.versionId,
          shareAccepted: true,
        }),
      );
      expect(sub.status).toBe(200);
      const id = (await sub.json()).id;
      expect(
        (
          await libraryPost(
            req("/api/skills/library", u, {
              action: "review",
              submissionId: id,
              decision: "APPROVED",
              note: "forged",
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await libraryPost(
            req("/api/skills/library", a, {
              action: "review",
              submissionId: id,
              decision: "APPROVED",
              note: "verified",
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await libraryPost(
            req("/api/skills/library", o, { action: "use", versionId: result.versionId }),
          )
        ).status,
      ).toBe(200);
    });
  },
);
