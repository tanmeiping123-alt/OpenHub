import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  receiptFailures: 0,
  queries: [] as string[],
}));
vi.mock("../db", () => ({
  withTransaction: async (fn: (client: PoolClient) => Promise<unknown>) =>
    fn({
      query: async (sql: string, args: unknown[] = []) => {
        state.queries.push(sql);
        if (sql.startsWith("SELECT * FROM skill_workflow_runs"))
          return { rows: state.row ? [state.row] : [] };
        if (sql.startsWith("INSERT INTO skill_workflow_runs")) {
          state.row = {
            id: args[0],
            owner_user_id: args[1],
            request_key: args[2],
            payload_sha256: args[3],
            status: "RUNNING",
          };
        }
        if (sql.startsWith("SELECT m.*"))
          return {
            rows: [
              {
                id: "execution",
                status: "SUCCEEDED",
                purpose: "PROMPT_GENERATION",
                output_text: "Saved output",
              },
            ],
          };
        if (sql.startsWith("UPDATE skill_workflow_runs SET status='SUCCEEDED'")) {
          if (state.receiptFailures-- > 0) throw new Error("Transient receipt write failure");
          Object.assign(state.row!, { status: "SUCCEEDED", result: JSON.parse(args[2] as string) });
        }
        if (sql.startsWith("UPDATE skill_workflow_runs SET status='FAILED'"))
          Object.assign(state.row!, {
            status: "FAILED",
            error_code: args[2],
            result: JSON.parse(args[3] as string),
          });
        if (sql.startsWith("UPDATE skill_workflow_runs SET status=$3"))
          Object.assign(state.row!, { status: args[2], result: JSON.parse(args[3] as string) });
        return { rows: state.row ? [state.row] : [], rowCount: 1 };
      },
    } as unknown as PoolClient),
}));
vi.mock("./skill-library", () => ({
  requireActor: () => ({ id: "owner", role: "USER" }),
  assertActiveActor: vi.fn(),
}));
vi.mock("./skill-context", () => ({
  loadWorkflowContext: async () => ({ goal: "A task", taskType: "General", locale: "en" }),
}));
vi.mock("../model/model-service", () => ({
  generateLivePrompt: vi.fn(async () => {
    state.row!.execution_id = "execution";
    return { executionId: "execution", content: "Saved output" };
  }),
  generateLiveSourceModel: vi.fn(),
}));
import { generateLivePrompt } from "../model/model-service";
import { runSkillPlan, skillWorkflowStatus } from "./skill-workflow-service";

describe("workflow receipt recovery after successful model execution", () => {
  beforeEach(() => {
    state.row = undefined;
    state.receiptFailures = 1;
    state.queries = [];
    vi.clearAllMocks();
  });

  it("returns the durable result and reconciles the same request without a second dispatch", async () => {
    const input = { planId: "plan", purpose: "PROMPT_GENERATION" as const };
    const receipt = await runSkillPlan(input, "same-key");
    expect(receipt).toMatchObject({ status: "SUCCEEDED", result: { content: "Saved output" } });
    expect(state.row?.status).toBe("RUNNING");
    expect(state.queries.some((sql) => sql.includes("SET status='FAILED'"))).toBe(false);

    const recovered = await skillWorkflowStatus("same-key");
    expect(recovered).toMatchObject({ status: "SUCCEEDED", result: { content: "Saved output" } });
    const replay = await runSkillPlan(input, "same-key");
    expect(replay).toMatchObject({ status: "SUCCEEDED", result: { content: "Saved output" } });
    expect(generateLivePrompt).toHaveBeenCalledTimes(1);
  });
});
