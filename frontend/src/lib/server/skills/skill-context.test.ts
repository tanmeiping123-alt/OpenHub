import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { analyzeSkillTask } from "@/lib/skill-workflow";
vi.mock("./skill-library", () => ({
  requireActor: () => ({ id: "owner", role: "USER" }),
  skillContent: vi.fn(),
}));
import { loadSkillContext, loadWorkflowContext } from "./skill-context";
import { skillContent } from "./skill-library";

function client(analysis: Record<string, unknown>) {
  return {
    query: vi.fn(async () => ({
      rows: [
        {
          goal: "Return one greeting",
          task_type: "General",
          locale: "en",
          selections: [],
          analysis,
        },
      ],
    })),
  } as unknown as PoolClient;
}

describe("immutable workflow context versions", () => {
  const simple = analyzeSkillTask("Return one greeting", "General", "en");
  it("keeps new zero-Skill simple plans out of model Skill context", async () => {
    const context = await loadWorkflowContext(
      client({ ...simple, contextVersion: "on-demand-v1" }),
      "plan",
    );
    expect(context.text).toBeUndefined();
    expect(context.taskPlanContext).toBeUndefined();
  });
  it("preserves a genuine stage package independently of Skill materials or descriptor metadata", async () => {
    const descriptor = { purposes: ["build"], tags: ["PRIVATE_DESCRIPTOR"] };
    const analysis = {
      ...analyzeSkillTask("Deliver two stages", "General", "en", "PROMPT_PACKAGE"),
      contextVersion: "on-demand-v1",
      descriptor,
    };
    const context = await loadWorkflowContext(client(analysis), "plan");
    expect(context.text).toBeUndefined();
    expect(context.taskPlanContext).toContain('"delivery":"PROMPT_PACKAGE"');
    expect(context.taskPlanContext).not.toContain("PRIVATE_DESCRIPTOR");
    expect(context.taskPlanContext).not.toContain("Skill");
    expect(context.descriptor).toEqual(descriptor);
  });
  it("retains the byte-exact historical context representation for unmarked plans", async () => {
    const analysis = { ...simple, matching: { mode: "MANUAL" } };
    const context = await loadWorkflowContext(client(analysis), "historical");
    expect(context.text).toBe(JSON.stringify({ task: analysis, selections: [], material: [] }));
    expect(context.taskPlanContext).toBeUndefined();
  });
  it("keeps descriptors out of selected Skill context while retaining the adopted material", async () => {
    vi.mocked(skillContent).mockResolvedValue({
      accessKind: "PERSONAL",
      resources: [],
      mainSha256: "main",
      body: "Task method",
      metadata: {},
      name: "Selected",
      manifestSha256: "manifest",
      source: {},
    } as unknown as Awaited<ReturnType<typeof skillContent>>);
    const c = client({
      ...simple,
      contextVersion: "on-demand-v1",
      descriptor: { purposes: [], tags: ["PRIVATE_DESCRIPTOR"] },
    });
    const selection = (
      await loadSkillContext(
        c,
        { id: "owner", role: "USER", email: "owner@example.test" },
        "version",
      )
    ).selection;
    vi.mocked(c.query).mockResolvedValue({
      rows: [
        {
          goal: simple.goal,
          task_type: "General",
          locale: "en",
          selections: [selection],
          analysis: {
            ...simple,
            contextVersion: "on-demand-v1",
            descriptor: { purposes: [], tags: ["PRIVATE_DESCRIPTOR"] },
          },
        },
      ],
    } as never);
    const context = await loadWorkflowContext(c, "plan");
    expect(context.text).toContain("Task method");
    expect(context.text).not.toContain("PRIVATE_DESCRIPTOR");
    expect(context.descriptor).toEqual({ purposes: [], tags: ["PRIVATE_DESCRIPTOR"] });
  });
});
