// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTaskSkills } from "./TaskSkills";
import { analyzeSkillTask } from "@/lib/skill-workflow";

const input = {
  goal: "Translate this sentence",
  taskType: "General" as const,
  locale: "en" as const,
  modelKey: "deepseek-direct",
};
const completed = {
  executionMode: "LIVE",
  executionId: "exe_one",
  promptId: "prm_one",
  versionId: "ver_one",
  content: "A concise Prompt",
  title: "Task",
  taskType: "General",
  provider: "deepseek",
  requestedModel: "deepseek-chat",
  resolvedModel: "deepseek-chat",
  productVersion: "test",
  latencyMs: 4,
  usage: { totalTokens: 12 },
};
function plan(goal = input.goal) {
  return { id: "swp_one", analysis: analyzeSkillTask(goal, "General", "en"), selections: [] };
}
beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("plans and runs a simple task with one action, storing the request before dispatch", async () => {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === "plan") return Response.json(plan());
      expect(
        JSON.parse(sessionStorage.getItem("pm-task-skills:usr_one:generate")!).pending.key,
      ).toBeTruthy();
      return Response.json({ status: "SUCCEEDED", result: completed });
    }),
  );
  const { result } = renderHook(() => useTaskSkills("usr_one", "generate"));
  await act(async () => {
    await result.current.run(input);
  });
  expect(calls).toHaveLength(2);
  expect(result.current.result?.content).toBe(completed.content);
  expect(result.current.pending).toBeUndefined();
});

it("requires review only for a real stage package and reuses the immutable plan", async () => {
  const task = {
    ...input,
    goal: "分两个阶段交付：第一阶段生成 schema；第二阶段根据上一步 schema 实现客户端。",
  };
  const calls: { action: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return Response.json(
        body.action === "plan" ? plan(task.goal) : { status: "SUCCEEDED", result: completed },
      );
    }),
  );
  const { result } = renderHook(() => useTaskSkills("usr_one", "generate"));
  await act(async () => {
    await result.current.run(task);
  });
  expect(calls.map((c) => c.action)).toEqual(["plan"]);
  expect(result.current.needsReview).toBe(true);
  await act(async () => {
    await result.current.run(task);
  });
  expect(calls.map((c) => c.action)).toEqual(["plan", "run"]);
});

it("manual is exact and explicit exclusion sends an empty overriding selection", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return Response.json(
        body.action === "plan" ? plan() : { status: "SUCCEEDED", result: completed },
      );
    }),
  );
  const { result } = renderHook(() => useTaskSkills("usr_one", "generate"));
  act(() => result.current.change({ preference: "MANUAL", selected: ["skv_private"] }));
  await act(async () => {
    await result.current.run(input);
  });
  expect(requests[0]).toMatchObject({
    matchingMode: "MANUAL",
    selectedVersionIds: ["skv_private"],
    manualOverride: true,
  });
  act(() => result.current.change({ preference: "NONE" }));
  await act(async () => {
    await result.current.run(input);
  });
  expect(requests[2]).toMatchObject({
    matchingMode: "MANUAL",
    selectedVersionIds: [],
    manualOverride: true,
  });
});

it("an unknown run survives remount, freezes edits, and reconciles using GET without redispatch", async () => {
  const fetcher = vi.fn(async (url, init) => {
    if (!init?.body) return Response.json({ status: "SUCCEEDED", result: completed });
    if (JSON.parse(init.body).action === "plan") return Response.json(plan());
    throw Error("offline");
  });
  vi.stubGlobal("fetch", fetcher);
  const first = renderHook(() => useTaskSkills("usr_one", "generate"));
  await act(async () => {
    await first.result.current.run(input);
  });
  const key = first.result.current.pending!.key;
  first.unmount();
  const restored = renderHook(() => useTaskSkills("usr_one", "generate"));
  act(() => restored.result.current.change({ preference: "NONE" }));
  expect(restored.result.current.preference).toBe("AUTO");
  await act(async () => {
    await restored.result.current.reconcile();
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2][0]).toContain(encodeURIComponent(key));
  expect(restored.result.current.result?.executionId).toBe("exe_one");
});

it("does not dispatch if the reconciliation handle cannot be saved", async () => {
  const fetcher = vi.fn(async () => Response.json(plan()));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("full");
  });
  const { result } = renderHook(() => useTaskSkills("usr_one", "generate"));
  await act(async () => {
    await result.current.run(input);
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.current.error).toBe("REQUEST_STORAGE_UNAVAILABLE");
});

it("keeps preferences scoped to an account and retains the authoritative task input", async () => {
  const { result, unmount } = renderHook(() => useTaskSkills("usr_one", "generate"));
  act(() => result.current.change({ goal: "Keep my unsent task", preference: "NONE" }));
  unmount();
  const restored = renderHook(() => useTaskSkills("usr_one", "generate"));
  expect(restored.result.current.goal).toBe("Keep my unsent task");
  expect(restored.result.current.preference).toBe("NONE");
  const other = renderHook(() => useTaskSkills("usr_other", "generate"));
  expect(other.result.current.goal).toBe("");
  expect(other.result.current.preference).toBe("AUTO");
  await waitFor(() => expect(other.result.current.pending).toBeUndefined());
});

it("adopts a library selection for the current task while preserving its goal", () => {
  sessionStorage.setItem(
    "pm-task-skills:usr_one:generate",
    JSON.stringify({ goal: "Keep this task", preference: "NONE", selected: [] }),
  );
  window.history.replaceState(
    null,
    "",
    "/en/app/generate?skillVersion=skv_11111111-1111-4111-8111-111111111111",
  );
  const { result } = renderHook(() => useTaskSkills("usr_one", "generate"));
  expect(result.current.goal).toBe("Keep this task");
  expect(result.current.preference).toBe("MANUAL");
  expect(result.current.selected).toEqual(["skv_11111111-1111-4111-8111-111111111111"]);
  expect(window.location.search).toBe("");
});

it("references an optimization source by identity without resending its body in the plan", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return Response.json(
        body.action === "plan"
          ? plan()
          : { status: "SUCCEEDED", result: { ...completed, purpose: "OPTIMIZATION" } },
      );
    }),
  );
  const { result } = renderHook(() => useTaskSkills("usr_one", "optimize:ver_one"));
  await act(async () => {
    await result.current.run({
      ...input,
      goal: "x".repeat(15000),
      source: { promptId: "prm_one", versionId: "ver_one", taskType: "General" },
    });
  });
  expect(requests[0]).toHaveProperty("source", { promptId: "prm_one", versionId: "ver_one" });
  expect(requests[0]).not.toHaveProperty("goal");
});

it("normalizes a recovered generation receipt carrying the server purpose", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      Response.json(
        JSON.parse(init.body).action === "plan"
          ? plan()
          : { status: "SUCCEEDED", result: { ...completed, purpose: "PROMPT_GENERATION" } },
      ),
    ),
  );
  const { result } = renderHook(() => useTaskSkills("usr_one", "generate"));
  await act(async () => {
    await result.current.run(input);
  });
  expect(result.current.result).not.toHaveProperty("purpose");
});

it("keeps a dispatched request locked if its result receipt cannot be saved", async () => {
  const original = Storage.prototype.setItem;
  let writes = 0;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (++writes > 1) throw Error("full");
    original.call(this, key, value);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      Response.json(
        JSON.parse(init.body).action === "plan"
          ? plan()
          : { status: "SUCCEEDED", result: completed },
      ),
    ),
  );
  const { result } = renderHook(() => useTaskSkills("usr_one", "generate"));
  await act(async () => {
    await result.current.run(input);
  });
  expect(result.current.error).toBe("RESULT_STORAGE_UNAVAILABLE");
  expect(result.current.pending).toBeTruthy();
  expect(result.current.locked).toBe(true);
});

it("retains an explicitly cleared descriptor across remounts and keeps it out of other tasks", () => {
  const first = renderHook(() => useTaskSkills("usr_one", "generate"));
  act(() =>
    first.result.current.change({
      goal: "Analyze sales",
      descriptorOverride: { purposes: [], tags: [] },
    }),
  );
  first.unmount();
  const restored = renderHook(() => useTaskSkills("usr_one", "generate"));
  expect(restored.result.current.descriptorOverride).toEqual({ purposes: [], tags: [] });
  expect(
    renderHook(() => useTaskSkills("usr_two", "generate")).result.current.descriptorOverride,
  ).toBeUndefined();
});
