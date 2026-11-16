import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelServiceError } from "@/lib/server/model/model-errors";
import { generateLivePrompt } from "@/lib/server/model/model-service";
import { POST } from "./route";

vi.mock("@/lib/server/model/model-service", () => ({ generateLivePrompt: vi.fn() }));

function request(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/ai/generate", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const result = {
  executionMode: "LIVE" as const,
  executionId: "mex_test_01",
  promptId: "prm_test_01",
  versionId: "ver_test_01",
  title: "Launch checklist",
  taskType: "Business" as const,
  content: "Act as a launch planner.",
  provider: "deepseek" as const,
  requestedModel: "deepseek-flash",
  resolvedModel: "deepseek-flash",
  productVersion: "DeepSeek-V4.1-Flash-1017",
  usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
  latencyMs: 500,
};

describe("live generation route", () => {
  it("generates without a legacy category and keeps optional metadata separate", async () => {
    const descriptor = { purposes: ["analyze", "create"], tags: ["经营", "汇报"] };
    const goal = "分析销售数据，找出下滑原因，再写给老板的汇报。";
    expect((await POST(request({ goal, locale: "zh-CN", descriptor }))).status).toBe(201);
    expect(generateLivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ goal, taskType: "General", descriptor }),
    );
  });

  it("rejects malformed descriptors before calling a model", async () => {
    for (const descriptor of [
      null,
      { purposes: ["unknown"], tags: [] },
      { purposes: [], tags: ["x".repeat(41)] },
    ]) {
      expect((await POST(request({ goal: "Write", locale: "en", descriptor }))).status).toBe(400);
    }
    expect(generateLivePrompt).not.toHaveBeenCalled();
  });
  it("forwards exact model and strength selectors, rejects client connection overrides", async () => {
    const body = {
      goal: "Plan",
      taskType: "Coding",
      locale: "en",
      modelKey: "deepseek-ai/DeepSeek-V4-Pro",
      strength: "max",
      maxOutputTokens: 512,
    };
    expect((await POST(request(body))).status).toBe(201);
    expect(generateLivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ modelKey: body.modelKey, strength: "max", maxOutputTokens: 512 }),
    );
    vi.mocked(generateLivePrompt).mockClear();
    for (const patch of [
      { modelKey: "unknown" },
      { strength: "low" },
      { provider: "deepseek" },
      { apiKey: "spoof" },
      { reasoning_effort: "high" },
    ])
      expect((await POST(request({ ...body, ...patch }))).status).toBe(400);
    expect(generateLivePrompt).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.mocked(generateLivePrompt).mockResolvedValue(result);
  });

  it("validates input and returns auditable live model metadata", async () => {
    const response = await POST(
      request({ goal: "Launch checklist", taskType: "Business", locale: "en" }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject(result);
    expect(generateLivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "Launch checklist",
        taskType: "Business",
        locale: "en",
      }),
    );
  });

  it("rejects malformed input before invoking the provider", async () => {
    const response = await POST(request({ goal: "", taskType: "Unknown", locale: "en" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_MODEL_GENERATION_INPUT" });
    expect(generateLivePrompt).not.toHaveBeenCalled();
  });

  it("returns a sanitized provider failure with its execution id", async () => {
    vi.mocked(generateLivePrompt).mockRejectedValue(
      new ModelServiceError(
        "DEEPSEEK_AUTHENTICATION_FAILED",
        "DeepSeek authentication failed. Check the server-side API key.",
        502,
        false,
        "mex_test_failed",
      ),
    );
    const response = await POST(
      request({ goal: "Launch checklist", taskType: "Business", locale: "en" }),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "DEEPSEEK_AUTHENTICATION_FAILED",
      message: "DeepSeek authentication failed. Check the server-side API key.",
      executionId: "mex_test_failed",
    });
  });
});
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(async () => ({
    id: "usr_unit_fixture",
    email: "fixture@example.test",
    role: "USER",
  })),
}));
