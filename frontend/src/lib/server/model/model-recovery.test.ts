import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db", () => ({
  getPool: () => ({ query }),
  withTransaction: (fn: (c: { query: typeof query }) => unknown) => fn({ query }),
}));
vi.mock("../repository", () => ({ initializeDemoData: async () => undefined }));
vi.mock("../identity-context", () => ({ workspaceOwnerId: () => "owner" }));
vi.mock("./model-quota-repository", () => ({ finalizeModelQuota: vi.fn() }));
vi.mock("../skills/skill-context", () => ({
  loadWorkflowContext: vi.fn(),
  recordExecutionSkillSources: vi.fn(),
}));
vi.mock("../billing/entitlements", () => ({ lockCapacity: vi.fn(), lockQuota: vi.fn() }));
import * as repository from "./model-repository";
const { createPendingModelExecution } = repository;
import type { LiveModelConfig } from "./model-types";
const config: LiveModelConfig = {
  mode: "LIVE",
  provider: "deepseek",
  apiKey: "synthetic",
  baseUrl: "https://example.test",
  model: "synthetic",
  productVersion: "test",
  timeoutMs: 1000,
  maxRetries: 0,
  maxOutputTokens: 1200,
  dailyTokenLimit: 100000,
  dailyCostLimitUsd: 5,
  pricingWindow: "AUTO",
};
const request = {
  config,
  inputSha256: "new-policy-hash",
  legacyInputSha256: "legacy-hash",
  requestIdentitySha256: "logical-request",
  policyVersion: "core-first-v1",
  messagesSha256: "a".repeat(64),
  purpose: "EVALUATION_REPORT" as const,
  promptId: "p",
  promptVersionId: "v",
  evaluationRequestKey: "key123456",
};
const previous = {
  id: "old-execution",
  created_at: "2026-11-01",
  status: "SUCCEEDED",
  prompt_id: "p",
  prompt_version_id: "v",
  input_sha256: "legacy-hash",
  request_identity_sha256: null,
};
describe("immutable model evidence and request recovery across policy upgrades", () => {
  beforeEach(() => query.mockReset());
  it("recovers an old successful report with its original hash without creating an execution", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [previous] });
    expect((await createPendingModelExecution(request)).replay?.id).toBe(previous.id);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each(["PENDING", "FAILED"])(
    "never permits redispatch of an old %s receipt after an upgrade",
    async (status) => {
      query
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ ...previous, status }] });
      await expect(createPendingModelExecution(request)).rejects.toMatchObject({
        code:
          status === "PENDING" ? "MODEL_EVALUATION_PENDING" : "MODEL_EVALUATION_PREVIOUSLY_FAILED",
        executionId: previous.id,
      });
    },
  );
  it("recovers a newer receipt using stable request identity even after another policy upgrade", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({
      rows: [
        {
          ...previous,
          input_sha256: "old-policy-hash",
          request_identity_sha256: request.requestIdentitySha256,
        },
      ],
    });
    expect((await createPendingModelExecution(request)).replay?.id).toBe(previous.id);
  });
  it("rejects reuse by a different logical request", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ ...previous, request_identity_sha256: "other-locale" }] });
    await expect(createPendingModelExecution(request)).rejects.toMatchObject({
      code: "MODEL_EVALUATION_REQUEST_CONFLICT",
    });
  });
  it("records immutable policy version, actual messages digest and logical identity on new executions", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });
    await createPendingModelExecution(request);
    expect(query.mock.calls[0][0]).toContain("model_policy_version");
    expect(query.mock.calls[0][0]).toContain("dispatched_messages_sha256");
    expect(query.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        request.policyVersion,
        request.messagesSha256,
        request.requestIdentitySha256,
      ]),
    );
  });
});

describe("Playground request recovery", () => {
  const playground = {
    ...request,
    purpose: "PLAYGROUND" as const,
    evaluationRequestKey: undefined,
    playgroundRequestKey: "playground-key-123",
  };
  beforeEach(() => query.mockReset());
  it("claims a dedicated Playground key without using evaluation fields", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await createPendingModelExecution(playground);
    expect(query.mock.calls[0][0]).toContain("playground_request_key");
    expect(query.mock.calls[0][0]).toContain("WHERE purpose='PLAYGROUND'");
    expect(query.mock.calls[0][1]).toContain(playground.playgroundRequestKey);
    expect(query.mock.calls[0][1]).not.toContain(request.evaluationRequestKey);
  });
  it.each(["SUCCEEDED", "PENDING", "FAILED"])(
    "retains a pre-upgrade %s receipt with its original lower output limit",
    async (status) => {
      const old = {
        ...previous,
        status,
        request_identity_sha256: "old-output-identity",
        output_token_limit: 1200,
        model_policy_version: "core-first-v1",
      };
      query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rows: [old] });
      const legacyOutputIdentity = (limit: number) =>
        limit === 1200 ? "old-output-identity" : undefined;
      const pending = createPendingModelExecution({
        ...playground,
        policyVersion: "core-first-full-output-v2",
        legacyOutputIdentity,
      });
      if (status === "SUCCEEDED") expect((await pending).replay).toEqual(old);
      else
        await expect(pending).rejects.toMatchObject({
          executionId: old.id,
          code:
            status === "PENDING"
              ? "MODEL_PLAYGROUND_PENDING"
              : "MODEL_PLAYGROUND_PREVIOUSLY_FAILED",
        });
      expect(query).toHaveBeenCalledTimes(2);
    },
  );
  it("replays the original successful receipt with its session", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({
      rows: [
        {
          ...previous,
          request_identity_sha256: playground.requestIdentitySha256,
          session_id: "saved-session",
        },
      ],
    });
    const result = await createPendingModelExecution(playground);
    expect(result.replay).toMatchObject({ id: previous.id, session_id: "saved-session" });
    expect(query.mock.calls[1][0]).toContain("purpose='PLAYGROUND'");
    expect(query.mock.calls[1][0]).toContain("owner_user_id=$1");
  });
  it.each(["PENDING", "FAILED"])("never redispatches a %s request", async (status) => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ ...previous, status, request_identity_sha256: playground.requestIdentitySha256 }],
    });
    await expect(createPendingModelExecution(playground)).rejects.toMatchObject({
      code:
        status === "PENDING" ? "MODEL_PLAYGROUND_PENDING" : "MODEL_PLAYGROUND_PREVIOUSLY_FAILED",
      executionId: previous.id,
    });
  });
  it("rejects a key reused for another locale/model/settings intent", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ ...previous, request_identity_sha256: "different-intent" }],
    });
    await expect(createPendingModelExecution(playground)).rejects.toMatchObject({
      code: "MODEL_PLAYGROUND_REQUEST_CONFLICT",
    });
  });
});

describe("read-only Playground recovery status", () => {
  beforeEach(() => query.mockReset());
  it("provides saved-status lookup", () => {
    expect("getPlaygroundRequestStatus" in repository).toBe(true);
  });
});
