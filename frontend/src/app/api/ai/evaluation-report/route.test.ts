import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { generateLiveSourceModel } from "@/lib/server/model/model-service";
import { sessionActor } from "@/lib/server/accounts";
vi.mock("@/lib/server/model/model-service", () => ({ generateLiveSourceModel: vi.fn() }));
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(),
}));
const body = { promptId: "p", versionId: "v", locale: "zh-CN", requestKey: "evaluation-key-1" };
function request(value: unknown, origin = "http://127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/api/ai/evaluation-report", {
    method: "POST",
    headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "development");
  vi.mocked(sessionActor).mockResolvedValue({
    id: "usr_fixture",
    role: "USER",
    email: "fixture@example.test",
  });
});
describe("direct model report route", () => {
  it("accepts validated direct reasoning and output choices without opening routing overrides", async () => {
    vi.mocked(generateLiveSourceModel).mockResolvedValue({ purpose: "EVALUATION_REPORT" } as never);
    expect((await POST(request({ ...body, strength: "low", maxOutputTokens: 32768 }))).status).toBe(
      201,
    );
    expect(generateLiveSourceModel).toHaveBeenCalledWith(
      expect.objectContaining({ strength: "low", maxOutputTokens: 32768 }),
    );
  });
  it("accepts only saved-version selectors and a recovery key", async () => {
    vi.mocked(generateLiveSourceModel).mockResolvedValue({ purpose: "EVALUATION_REPORT" } as never);
    expect((await POST(request(body))).status).toBe(201);
    expect(generateLiveSourceModel).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "EVALUATION_REPORT",
        promptId: "p",
        versionId: "v",
        evaluationRequestKey: body.requestKey,
      }),
    );
  });
  it.each([
    { modelKey: "deepseek-ai/DeepSeek-V4-Pro" },
    { apiKey: "untrusted" },
    { sourceContent: "spoofed" },
    { evaluation: {} },
    { requestKey: "" },
    { promptId: "" },
    { locale: "bad" },
    { score: 100 },
    { skillPlanId: "untrusted" },
  ])("rejects client supplied evidence or routing overrides %j", async (patch) => {
    expect((await POST(request({ ...body, ...patch }))).status).toBe(400);
    expect(generateLiveSourceModel).not.toHaveBeenCalled();
  });
  it("rejects anonymous and cross-origin requests before supplier dispatch", async () => {
    vi.mocked(sessionActor).mockResolvedValue(null);
    expect((await POST(request(body))).status).toBe(401);
    expect((await POST(request(body, "https://evil.test"))).status).toBe(403);
    expect(generateLiveSourceModel).not.toHaveBeenCalled();
  });
  it("bounds the request body", async () => {
    expect((await POST(request({ ...body, extra: "x".repeat(5000) }))).status).toBe(413);
    expect(generateLiveSourceModel).not.toHaveBeenCalled();
  });
});
