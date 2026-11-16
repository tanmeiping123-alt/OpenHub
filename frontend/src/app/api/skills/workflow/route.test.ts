import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/accounts", async (original) => ({
  ...(await original<typeof import("@/lib/server/accounts")>()),
  sessionActor: vi.fn(async () => ({ id: "unit-owner", email: "unit@example.test", role: "USER" })),
}));
vi.mock("@/lib/server/skills/skill-workflow-service", () => ({
  createSkillPlan: vi.fn(async (input) => ({ id: "plan", ...input })),
  runSkillPlan: vi.fn(),
  skillWorkflowStatus: vi.fn(),
}));
import { createSkillPlan } from "@/lib/server/skills/skill-workflow-service";
import { POST } from "./route";
const body = {
  action: "plan",
  goal: "Return one greeting",
  locale: "en",
  matchingMode: "AUTO",
  selectedVersionIds: [],
};
function request(patch: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/skills/workflow", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, ...patch }),
  });
}
describe("on-demand workflow plan metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
  });
  it("normalizes optional descriptors while retaining legacy task type defaults", async () => {
    const response = await POST(
      request({ descriptor: { purposes: ["build", "build"], tags: ["  Report  "] } }),
    );
    expect(response.status).toBe(200);
    expect(createSkillPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "General",
        descriptor: { purposes: ["build"], tags: ["Report"] },
      }),
    );
  });
  it("rejects malformed descriptor metadata before creating any plan", async () => {
    for (const descriptor of [
      null,
      { purposes: ["unknown"], tags: [] },
      { purposes: [], tags: ["x".repeat(41)] },
    ])
      expect((await POST(request({ descriptor }))).status).toBe(400);
    expect(createSkillPlan).not.toHaveBeenCalled();
  });
  it("accepts an exclusive saved source reference instead of duplicating its body", async () => {
    const source = { promptId: "prm_source", versionId: "ver_source" };
    expect((await POST(request({ goal: undefined, source }))).status).toBe(200);
    expect(createSkillPlan).toHaveBeenCalledWith(expect.objectContaining({ source }));
    vi.mocked(createSkillPlan).mockClear();
    for (const patch of [
      { source },
      { goal: undefined, source: { ...source, owner: "forged" } },
      { goal: undefined, source: { promptId: "prm_source" } },
    ])
      expect((await POST(request(patch))).status).toBe(400);
    expect(createSkillPlan).not.toHaveBeenCalled();
  });
  it("accepts report identity and indexes only with a saved source, never client-authored advice", async () => {
    const source = { promptId: "prm_source", versionId: "ver_source" };
    const evaluationHandoff = { reportId: "mex_report", indexes: [0] };
    expect((await POST(request({ goal: undefined, source, evaluationHandoff }))).status).toBe(200);
    expect(createSkillPlan).toHaveBeenCalledWith(
      expect.objectContaining({ source, evaluationHandoff }),
    );
    vi.mocked(createSkillPlan).mockClear();
    for (const patch of [
      { evaluationHandoff },
      { goal: undefined, source, evaluationHandoff: { ...evaluationHandoff, text: "Forged" } },
      { goal: undefined, source, evaluationHandoff: { reportId: "mex_report", indexes: [3] } },
    ])
      expect((await POST(request(patch))).status).toBe(400);
    expect(createSkillPlan).not.toHaveBeenCalled();
  });
});
