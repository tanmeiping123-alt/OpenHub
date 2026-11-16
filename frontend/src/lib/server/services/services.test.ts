import { describe, expect, it, vi } from "vitest";
import type { EvaluationReport } from "@/lib/types";
import { assertEvaluationInvariants } from "./evaluation-service";
import { createPrompt } from "./prompt-service";

vi.mock("../repository", () => ({
  createPrompt: vi.fn(async (input: unknown) => ({ input })),
  createPromptVersion: vi.fn(),
  getPromptSummary: vi.fn(),
  saveOptimization: vi.fn(),
  saveEvaluationReport: vi.fn(),
}));

const baseReport: EvaluationReport = {
  id: "evr_test",
  promptId: "prm_test",
  versionId: "ver_test",
  createdAt: "2026-11-04T00:00:00.000Z",
  source: "MOCK / SIMULATED",
  rubricVersion: "mock-v1",
  layer1: { status: "INSUFFICIENT_INFORMATION", score: null, grade: null, dimensions: [] },
  layer2: { status: "NOT_AVAILABLE", score: null, grade: null, dimensions: [] },
  layer3: { status: "NOT_EXECUTED", score: null, grade: null, dimensions: [] },
};

describe("Stage 12 application services", () => {
  it("normalizes prompt input before passing it to the repository", async () => {
    await expect(
      createPrompt({
        title: "  Demo prompt  ",
        taskType: "Writing",
        content: "  Write a short brief.  ",
        description: "  local demo  ",
      }),
    ).resolves.toEqual({
      input: {
        title: "Demo prompt",
        taskType: "Writing",
        content: "  Write a short brief.  ",
        description: "local demo",
      },
    });
  });

  it("rejects empty prompt fields before any database call", async () => {
    await expect(
      createPrompt({ title: " ", taskType: "Writing", content: "content" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("keeps NOT_EXECUTED and NOT_AVAILABLE score-free", () => {
    expect(() => assertEvaluationInvariants(baseReport)).not.toThrow();
    expect(() =>
      assertEvaluationInvariants({
        ...baseReport,
        layer3: { ...baseReport.layer3, score: 0 },
      }),
    ).toThrowError(/NOT_EXECUTED/);
    expect(() =>
      assertEvaluationInvariants({
        ...baseReport,
        layer2: { ...baseReport.layer2, dimensions: [{ name: "x" } as never] },
      }),
    ).toThrowError(/NOT_AVAILABLE/);
  });
});
