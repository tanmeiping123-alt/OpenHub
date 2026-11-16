import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateLiveSourceModel } from "@/lib/server/model/model-service";
import { POST as optimize } from "./optimize/route";
import { POST as playground } from "./playground/route";
import { POST as advice } from "./evaluation-advice/route";

vi.mock("@/lib/server/model/model-service", () => ({ generateLiveSourceModel: vi.fn() }));

function request(path: string, body: unknown) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const baseResult = {
  executionMode: "LIVE" as const,
  purpose: "OPTIMIZATION" as const,
  executionId: "mex_13a2",
  promptId: "prm_writing_course_01",
  versionId: "ver_writing_course_03",
  content: "Improved prompt",
  provider: "deepseek" as const,
  requestedModel: "deepseek-flash",
  resolvedModel: "deepseek-flash",
  productVersion: "DeepSeek-V4.1-Flash-1017",
  usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  latencyMs: 500,
};

describe("Stage 13A-2 live routes", () => {
  it.each([optimize, playground, advice])(
    "forwards allowlisted model settings and rejects spoofed provider fields",
    async (handler) => {
      const body = {
        promptId: "p",
        versionId: "v",
        locale: "en",
        requestKey: "stage13-test-request",
        modelKey: "deepseek-ai/DeepSeek-V4-Pro",
        strength: "high",
        maxOutputTokens: 512,
      };
      await handler(request("/api/ai/optimize", body));
      expect(generateLiveSourceModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelKey: body.modelKey,
          strength: "high",
          maxOutputTokens: 512,
        }),
      );
      vi.mocked(generateLiveSourceModel).mockClear();
      for (const patch of [
        { strength: "low" },
        { apiKey: "spoof" },
        { modelKey: "unknown" },
        { baseUrl: "https://evil.test" },
      ]) {
        expect((await handler(request("/api/ai/optimize", { ...body, ...patch }))).status).toBe(
          400,
        );
      }
      expect(generateLiveSourceModel).not.toHaveBeenCalled();
    },
  );
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.mocked(generateLiveSourceModel).mockResolvedValue(baseResult);
  });

  it.each([
    ["OPTIMIZATION", "/api/ai/optimize", optimize],
    ["PLAYGROUND", "/api/ai/playground", playground],
    ["EVALUATION_ADVICE", "/api/ai/evaluation-advice", advice],
  ] as const)("maps %s to an exact PromptVersion", async (purpose, path, handler) => {
    vi.mocked(generateLiveSourceModel).mockResolvedValue({ ...baseResult, purpose });
    const response = await handler(
      request(path, {
        promptId: "prm_writing_course_01",
        versionId: "ver_writing_course_03",
        locale: "en",
        ...(purpose === "PLAYGROUND" ? { requestKey: "stage13-test-request" } : {}),
      }),
    );
    expect(response.status).toBe(201);
    expect(generateLiveSourceModel).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose,
        promptId: "prm_writing_course_01",
        versionId: "ver_writing_course_03",
      }),
    );
  });

  it("rejects an invalid source-version request before model execution", async () => {
    const response = await optimize(
      request("/api/ai/optimize", { promptId: "", versionId: "bad", locale: "en" }),
    );
    expect(response.status).toBe(400);
    expect(generateLiveSourceModel).not.toHaveBeenCalled();
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
