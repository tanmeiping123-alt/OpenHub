import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  pending: vi.fn(),
  complete: vi.fn(),
  source: vi.fn(),
}));
vi.mock("./model-config", () => ({
  readModelConfig: () => ({
    mode: "LIVE",
    provider: "deepseek",
    apiKey: "synthetic-never-network",
    baseUrl: "https://example.test",
    model: "synthetic",
    productVersion: "test",
    timeoutMs: 1000,
    maxRetries: 0,
    maxOutputTokens: 1200,
    dailyTokenLimit: 100000,
    dailyCostLimitUsd: 5,
    pricingWindow: "AUTO",
  }),
}));
vi.mock("./model-repository", () => ({
  createPendingModelExecution: mocks.pending,
  completeModelExecutionWithPrompt: mocks.complete,
  completeSourceModelExecution: mocks.source,
  failModelExecution: vi.fn(),
}));
vi.mock("./model-quota-repository", () => ({
  reserveModelQuota: mocks.reserve,
  markModelAttempt: vi.fn(),
  getModelQuotaSummary: vi.fn(),
}));
vi.mock("../db", () => ({ withTransaction: vi.fn(), getPool: vi.fn() }));
vi.mock("../skills/skill-context", () => ({ loadWorkflowContext: vi.fn() }));
vi.mock("../services/prompt-service", () => ({
  getPromptForEvaluation: async () => ({ taskType: "General" }),
  getPromptVersion: async () => ({ content: "Return fenced JSON with value 42" }),
}));
import { generateLivePrompt, generateLiveSourceModel } from "./model-service";

describe("service quota and dispatched evidence boundary (no database or network)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it.each(["PROMPT_GENERATION", "PLAYGROUND"] as const)(
    "uses byte-identical actual %s messages for quota and immutable evidence",
    async (purpose) => {
      mocks.pending.mockResolvedValue({ executionId: "synthetic" });
      mocks.complete.mockResolvedValue({ promptId: "p", versionId: "v" });
      mocks.source.mockResolvedValue({ completedAt: "2026-11-10" });
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({
          model: "synthetic",
          choices: [{ message: { content: "Synthetic body" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      vi.stubGlobal("fetch", fetchImpl);
      const descriptor = { purposes: ["build" as const], tags: ["PRIVATE_TAG"] };
      if (purpose === "PROMPT_GENERATION")
        await generateLivePrompt({
          goal: "Write one greeting",
          taskType: "Writing",
          locale: "en",
          descriptor,
        });
      else await generateLiveSourceModel({ purpose, promptId: "p", versionId: "v", locale: "en" });
      const messages = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).messages;
      const serialized = JSON.stringify(messages);
      expect(mocks.reserve.mock.calls[0][0].serializedMessages).toBe(serialized);
      expect(mocks.pending.mock.calls[0][0]).toMatchObject({
        policyVersion: "core-first-full-output-v2",
        messagesSha256: createHash("sha256").update(serialized).digest("hex"),
      });
      expect(serialized).not.toContain("PRIVATE_TAG");
      if (purpose === "PROMPT_GENERATION")
        expect(mocks.complete.mock.calls[0][0].descriptor).toEqual(descriptor);
    },
  );
});
