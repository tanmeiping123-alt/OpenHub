import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCalibrationReport, emptyAssessments } from "@/lib/calibration";
import { prompts, versions } from "@/lib/fixtures";
import { getPromptForEvaluation, getPromptVersion } from "@/lib/server/services/prompt-service";
import { saveEvaluationReport } from "@/lib/server/services/evaluation-service";
import { POST } from "./route";

vi.mock("@/lib/server/services/prompt-service", () => ({
  getPromptForEvaluation: vi.fn(),
  getPromptVersion: vi.fn(),
}));

vi.mock("@/lib/server/services/evaluation-service", () => ({
  saveEvaluationReport: vi.fn(),
}));

const prompt = prompts.find((item) => item.id === "prm_general_notes_01")!;
const version = versions.find((item) => item.id === "ver_general_notes_01")!;
const assessments = emptyAssessments().map((item) => ({
  ...item,
  status: "NOT_APPLICABLE" as const,
  reason: "This synthetic route test does not assess this indicator.",
}));
const candidate = createCalibrationReport(prompt, version, assessments);

function request(body: unknown) {
  return new Request(`http://127.0.0.1:3000/api/prompts/${prompt.id}/evaluations`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("evaluation report route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.mocked(getPromptForEvaluation).mockResolvedValue(prompt);
    vi.mocked(getPromptVersion).mockResolvedValue(version);
    vi.mocked(saveEvaluationReport).mockResolvedValue(true);
  });

  it("persists a valid local calibration snapshot against its exact PromptVersion", async () => {
    const response = await POST(
      request({
        versionId: version.id,
        rubricVersion: candidate.rubricVersion,
        layer1: candidate.layer1,
        layer2: candidate.layer2,
        source: candidate.source,
        calibration: candidate.calibration,
      }),
      { params: Promise.resolve({ promptId: prompt.id }) },
    );

    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.source).toBe("LOCAL_HUMAN_CALIBRATION");
    expect(result.versionId).toBe(version.id);
    expect(result.calibration.assessedText).toBe(version.content);
    expect(result.layer2).toEqual({
      status: "NOT_AVAILABLE",
      score: null,
      grade: null,
      dimensions: [],
    });
    expect(result.layer3).toEqual({
      status: "NOT_EXECUTED",
      score: null,
      grade: null,
      dimensions: [],
    });
    expect(saveEvaluationReport).toHaveBeenCalledWith(expect.objectContaining(result));
  });

  it("rejects a calibration snapshot whose evidence text differs from the bound version", async () => {
    const response = await POST(
      request({
        versionId: version.id,
        rubricVersion: candidate.rubricVersion,
        layer1: candidate.layer1,
        layer2: candidate.layer2,
        source: candidate.source,
        calibration: { ...candidate.calibration, assessedText: "different source text" },
      }),
      { params: Promise.resolve({ promptId: prompt.id }) },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INVALID_CALIBRATION_INPUT" });
    expect(saveEvaluationReport).not.toHaveBeenCalled();
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
