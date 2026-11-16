// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PelicanAdminBatch, PelicanSample } from "@/lib/pelican-types";
import { PelicanPage, SampleCard } from "./PelicanPage";

export const sample: PelicanSample = {
  id: "sample-1",
  batchId: "batch-1",
  modelKey: "deepseek-direct",
  modelName: "Frozen model name",
  provider: "deepseek",
  requestedModel: "frozen-alias",
  resolvedModel: "response-model",
  strength: "off",
  maxOutputTokens: 4096,
  reasoningTokenReserve: 0,
  timeoutMs: 30000,
  generatedAt: "2026-11-09T02:00:00.000Z",
  latencyMs: 1800,
  callStatus: "SUCCEEDED",
  previewStatus: "READY",
  previewReason: null,
  finishReason: "stop",
  rerunOf: null,
  hasThumbnail: true,
  interrupted: false,
  withdrawn: false,
  withdrawnReason: null,
};
const batch: PelicanAdminBatch = {
  id: "batch-1",
  title: "真实测试批次",
  challengeVersion: "pelican-svg-v1",
  createdAt: "2026-11-09T01:00:00Z",
  publishedAt: "2026-11-10T01:00:00Z",
  status: "PUBLISHED",
  samples: [sample],
  estimatedCostUsd: 0.03,
  estimatedTokens: 4096,
  budgetFingerprint: "budget-1",
  canRun: false,
  canPublish: false,
  canDelete: false,
  blockedReason: null,
  runBlock: null,
};
const listing = {
  batches: [batch],
  models: [{ key: sample.modelKey, name: sample.modelName }],
  page: 1,
  hasMore: false,
};
const admin = {
  batches: [],
  models: [{ key: "deepseek-direct", configured: true, maxOutputTokens: 4096, timeoutMs: 30000 }],
  page: 1,
  hasMore: false,
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:frame"), revokeObjectURL: vi.fn() }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
async function renderAdmin(element: React.ReactElement) {
  // Old fixtures supplied a listing for every GET. Model the detail endpoint explicitly.
  const fetcher = vi.mocked(globalThis.fetch);
  const previous = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const response = await previous(url, init);
    if (!init?.method && /^\/api\/pelican\/admin\/[^/?]+$/.test(String(url)) && response.ok) {
      const value = await response.clone().json();
      if (!value.batch && value.batches)
        return Response.json({
          batch: value.batches.find(
            (b: PelicanAdminBatch) => b.id === String(url).split("/").at(-1),
          ),
        });
    }
    return response;
  });
  const view = render(element);
  const create = await screen.findByText("新建测试");
  fireEvent.click(create);
  // Follow the management entry point before exercising existing billing actions.
  const first = screen.queryAllByRole("button", { name: /管理批次：/ })[0];
  if (first) {
    fireEvent.click(first);
    await screen.findByRole("region", { name: "当前批次详情" });
  }
  return view;
}
function mocks(role: "ADMIN" | null = null, adminData: object = admin) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes("/viewer"))
      return Response.json({ role, accountScope: role ? "account-A" : undefined });
    if (path.includes("/preview/session-1"))
      return init?.method === "POST"
        ? Response.json({ ok: true })
        : new Response(new Blob(["frame"], { type: "image/png" }));
    if (path === "/api/pelican/preview")
      return Response.json({
        sessionId: "session-1",
        paused: false,
        expiresAt: "2026-11-10T12:00:00Z",
      });
    if (path.includes("/admin")) return Response.json(adminData);
    return Response.json(listing);
  });
}
it("lets an anonymous visitor browse frozen identities, generation time and history without private requests", async () => {
  const fetcher = mocks();
  render(<PelicanPage locale="zh-CN" />);
  expect(await screen.findByRole("button", { name: /打开作品.*Frozen model name/ })).toBeTruthy();
  expect(screen.getByText("2026/11/09 10:00:00")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "模型历史" }));
  await screen.findByRole("option", { name: "Frozen model name" });
  fireEvent.change(screen.getByLabelText("选择模型"), { target: { value: "deepseek-direct" } });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([u]) => String(u).includes("view=history&modelKey=deepseek-direct")),
    ).toBe(true),
  );
  expect(
    fetcher.mock.calls.some(([u, i]) => /admin|\/api\/ai/.test(String(u)) || i?.method === "POST"),
  ).toBe(false);
});
it("pauses and resumes the same isolated session and closes on Escape with focus restored", async () => {
  const fetcher = mocks();
  render(<PelicanPage locale="zh-CN" />);
  const card = await screen.findByRole("button", { name: /打开作品.*Frozen model name/ });
  card.focus();
  fireEvent.click(card);
  fireEvent.click(await screen.findByRole("button", { name: "暂停骑行" }));
  await screen.findByRole("button", { name: "继续骑行" });
  expect(
    fetcher.mock.calls.some(
      ([u, i]) =>
        String(u).endsWith("session-1") && i?.body === JSON.stringify({ action: "pause" }),
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "继续骑行" }));
  await screen.findByRole("button", { name: "暂停骑行" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(card);
  expect(fetcher.mock.calls.filter(([u]) => String(u) === "/api/pelican/preview")).toHaveLength(1);
  expect(fetcher.mock.calls.some(([, i]) => i?.body === JSON.stringify({ action: "close" }))).toBe(
    true,
  );
});
it("shows a static result honestly with no fake playback control", async () => {
  mocks().mockImplementation(async (url) =>
    Response.json(
      String(url).includes("viewer")
        ? { role: null }
        : {
            ...listing,
            batches: [{ ...batch, samples: [{ ...sample, previewStatus: "STATIC" }] }],
          },
    ),
  );
  render(<PelicanPage locale="zh-CN" />);
  fireEvent.click(await screen.findByRole("button", { name: /打开作品/ }));
  expect(await screen.findByText("预览观察时段内，未观察到画面变化。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "暂停骑行" })).toBeNull();
});
it("does not call the admin endpoint for an unauthorized viewer", async () => {
  const fetcher = mocks();
  render(<PelicanPage locale="zh-CN" manage />);
  expect(await screen.findByRole("heading", { name: "需要管理员权限" })).toBeTruthy();
  expect(fetcher.mock.calls.some(([u]) => String(u).includes("/admin"))).toBe(false);
});
it("stores a create receipt before POST and never dispatches when creation is uncertain", async () => {
  const fetcher = mocks("ADMIN");
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).includes("viewer"))
      return Response.json({ role: "ADMIN", accountScope: "account-A" });
    if (init?.method === "POST") {
      expect(sessionStorage.getItem("pelican:create:account-A")).toBeTruthy();
      throw new TypeError("network");
    }
    return Response.json(admin);
  });
  const view = await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /DeepSeek-V4.1-Flash-1017/ }));
  fireEvent.change(screen.getByLabelText("批次名称"), { target: { value: "新批次" } });
  fireEvent.click(screen.getByRole("button", { name: "创建批次并查看预算" }));
  await screen.findByText(/创建结果待核对/);
  view.unmount();
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("button", { name: "核对创建结果" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([u]) => String(u).includes("requestKey="))).toBe(true),
  );
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
});
it("creates a maximum-output batch with no lower budget control", async () => {
  const largeAdmin = { ...admin, models: [{ ...admin.models[0], maxOutputTokens: 393216 }] };
  const fetcher = mocks("ADMIN", largeAdmin);
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).includes("viewer"))
      return Response.json({ role: "ADMIN", accountScope: "account-A" });
    if (init?.method === "POST")
      return Response.json({ batch: { ...batch, id: "new", status: "DRAFT", samples: [] } });
    return Response.json(largeAdmin);
  });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /DeepSeek-V4.1-Flash-1017/ }));
  expect(screen.getByText(/393216 tokens · 模型最高上限/)).toBeTruthy();
  expect(screen.queryByLabelText("DeepSeek-V4.1-Flash-1017 输出预算模式")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  fireEvent.change(screen.getByLabelText("批次名称"), { target: { value: "自动预算批次" } });
  fireEvent.click(screen.getByRole("button", { name: "创建批次并查看预算" }));
  await screen.findByText(/批次已创建/);
  const first = fetcher.mock.calls.find(([, init]) => init?.method === "POST")![1]!;
  expect(JSON.parse(String(first.body)).selections).toEqual([
    { modelKey: "deepseek-direct", strength: "off" },
  ]);

  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/ai"))).toBe(false);
});
it("requires budget confirmation for execution, shows failed samples, and refresh only reads", async () => {
  const draft = {
    ...batch,
    publishedAt: null,
    status: "DRAFT",
    canRun: true,
    samples: [
      { ...sample, callStatus: "QUEUED" },
      { ...sample, id: "failed", callStatus: "FAILED", previewStatus: "INVALID" },
    ],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [draft] });
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).includes("viewer"))
      return Response.json({ role: "ADMIN", accountScope: "account-A" });
    return Response.json(
      init?.method === "POST"
        ? { batch: { ...draft, status: "RUNNING", canRun: false } }
        : { ...admin, batches: [draft] },
    );
  });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  const run = await screen.findByRole("button", { name: "发起真实测试" });
  expect(run.hasAttribute("disabled")).toBe(true);
  expect(screen.getAllByText("调用失败").length).toBeGreaterThan(0);
  const deadline = vi.spyOn(AbortSignal, "timeout");
  fireEvent.click(screen.getByRole("checkbox", { name: /确认本批预计费用/ }));
  fireEvent.click(run);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([, i]) =>
          i?.body ===
          JSON.stringify({ action: "run", confirmed: true, budgetFingerprint: "budget-1" }),
      ),
    ).toBe(true),
  );
  expect(deadline).toHaveBeenCalledWith(20000);
  expect(deadline).not.toHaveBeenCalledWith(80000);
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1);
});
it("closes a late preview session after the dialog was dismissed", async () => {
  const fetcher = mocks();
  let resolveSession!: (response: Response) => void;
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) =>
    String(url) === "/api/pelican/preview"
      ? new Promise<Response>((resolve) => {
          resolveSession = resolve;
        })
      : base(url, init),
  );
  render(<PelicanPage locale="zh-CN" />);
  fireEvent.click(await screen.findByRole("button", { name: /打开作品/ }));
  fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
  resolveSession(
    Response.json({ sessionId: "session-1", paused: false, expiresAt: "2026-11-10T12:00:00Z" }),
  );
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([, init]) => init?.body === JSON.stringify({ action: "close" })),
    ).toBe(true),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("closes the dialog and revalidates after preview access is withdrawn", async () => {
  const fetcher = mocks();
  const base = fetcher.getMockImplementation()!;
  let withdrawn = false;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === "/api/pelican/preview") {
      withdrawn = true;
      return Response.json({ error: "secret-backend-output" }, { status: 404 });
    }
    if (withdrawn && String(url).includes("/api/pelican?"))
      return Response.json({ ...listing, batches: [] });
    return base(url, init);
  });
  render(<PelicanPage locale="zh-CN" />);
  fireEvent.click(await screen.findByRole("button", { name: /打开作品/ }));
  await screen.findByText("还没有已发布作品");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("secret-backend-output")).toBeNull();
});
it("retains an uncertain run identity across remount and permits only state reads", async () => {
  const draft = {
    ...batch,
    status: "DRAFT",
    canRun: true,
    samples: [{ ...sample, callStatus: "QUEUED" }],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [draft] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "POST") throw new TypeError("network");
    return base(url, init);
  });
  const view = await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /确认本批预计费用/ }));
  fireEvent.click(screen.getByRole("button", { name: "发起真实测试" }));
  await screen.findByText(/操作结果待核对/);
  view.unmount();
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  const run = await screen.findByRole("button", { name: "发起真实测试" });
  expect(run.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1),
  );
  expect(sessionStorage.getItem("pelican:action:account-A")).toContain("batch-1");
});
it("disposes every strict-mode preview setup, including a late first setup", async () => {
  const fetcher = mocks();
  const base = fetcher.getMockImplementation()!;
  let sessions = 0;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === "/api/pelican/preview") {
      const current = ++sessions;
      await Promise.resolve();
      return Response.json({
        sessionId: `strict-${current}`,
        paused: false,
        expiresAt: "2026-11-10T12:00:00Z",
      });
    }
    if (String(url).includes("strict-"))
      return init?.method === "POST"
        ? Response.json({ ok: true })
        : new Response(new Blob(["frame"]));
    return base(url, init);
  });
  render(
    <StrictMode>
      <PelicanPage locale="zh-CN" />
    </StrictMode>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /打开作品/ }));
  await screen.findByRole("button", { name: "暂停骑行" });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          String(url).includes("strict-1") && init?.body === JSON.stringify({ action: "close" }),
      ),
    ).toBe(true),
  );
});
it("reconciles an uncertain rerun with its exact persisted request identity", async () => {
  sessionStorage.setItem(
    "pelican:action:account-A",
    JSON.stringify({
      batchId: batch.id,
      action: "rerun",
      requestKey: "exact-rerun-key",
      sampleId: sample.id,
    }),
  );
  const fetcher = mocks("ADMIN", { ...admin, batches: [batch] });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("button", { name: "刷新状态" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("rerunRequestKey=exact-rerun-key")),
    ).toBe(true),
  );
  await waitFor(() => expect(sessionStorage.getItem("pelican:action:account-A")).toBeNull());
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("loads privileged request evidence only on demand and keeps output HTML out of the interface", async () => {
  const fetcher = mocks("ADMIN", { ...admin, batches: [batch] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url).includes("/evidence")
      ? Response.json({
          evidence: {
            prompt: "固定题目",
            requestPayload: { messages: [{ role: "user", content: "固定题目" }] },
            executionId: "execution-1",
            status: "SUCCEEDED",
            usage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
            providerRequestId: "provider-1",
            model: "response-model",
            finishReason: "stop",
            generatedAt: sample.generatedAt,
            latencyMs: 1800,
            errorCode: null,
            rawOutput: "<script>private output</script>",
          },
        })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  const evidence = await screen.findByText("调用与用量记录");
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/evidence"))).toBe(false);
  fireEvent.click(evidence);
  expect(await screen.findByText("execution-1")).toBeTruthy();
  expect(screen.getByText("46")).toBeTruthy();
  expect(screen.queryByText(/private output/)).toBeNull();
});
it("retains batch choices while displaying exactly one selected batch", async () => {
  const older = {
    ...batch,
    id: "older",
    title: "旧批次",
    samples: [{ ...sample, id: "old-sample", batchId: "older", modelName: "Older snapshot" }],
  };
  const fetcher = mocks();
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url).includes("/api/pelican?")
      ? Response.json({ ...listing, batches: [batch, older] })
      : base(url, init),
  );
  render(<PelicanPage locale="zh-CN" />);
  fireEvent.click(await screen.findByRole("button", { name: "本期对比" }));
  fireEvent.change(await screen.findByLabelText("选择批次"), { target: { value: "older" } });
  expect(await screen.findByRole("button", { name: /打开作品.*Older snapshot/ })).toBeTruthy();
  expect(screen.getByLabelText("选择批次").querySelectorAll("option")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /打开作品.*Frozen model name/ })).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("batchId=older"))).toBe(false);
});
it("allows correcting a definitively rejected creation while preserving uncertain intent", async () => {
  const fetcher = mocks("ADMIN");
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST"
      ? Response.json({ error: "MODEL_DISABLED" }, { status: 503 })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /DeepSeek-V4.1-Flash-1017/ }));
  fireEvent.change(screen.getByLabelText("批次名称"), { target: { value: "可纠正" } });
  fireEvent.click(screen.getByRole("button", { name: "创建批次并查看预算" }));
  await screen.findByText(/创建请求未获接受/);
  expect(sessionStorage.getItem("pelican:create:account-A")).toBeNull();
  expect(screen.getByRole("button", { name: "创建批次并查看预算" }).hasAttribute("disabled")).toBe(
    false,
  );
});
it("prepares an existing successful result without issuing a new model run", async () => {
  const pendingPreview = {
    ...batch,
    status: "COMPLETE",
    samples: [{ ...sample, previewStatus: "PENDING" }],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [pendingPreview] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST"
      ? Response.json({ batch: { ...batch, status: "COMPLETE" } })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("button", { name: "准备已有结果预览" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([, init]) => init?.body === JSON.stringify({ action: "preview", sampleId: sample.id }),
      ),
    ).toBe(true),
  );
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(sessionStorage.getItem("pelican:action:account-A")).toBeNull();
});
it("rechecks administrator identity on focus before restoring another account's intent", async () => {
  sessionStorage.setItem(
    "pelican:create:account-A",
    JSON.stringify({ requestKey: "old-account", title: "上个账号的批次", selections: [] }),
  );
  const fetcher = mocks("ADMIN");
  const base = fetcher.getMockImplementation()!;
  let account = "account-A";
  fetcher.mockImplementation(async (url, init) =>
    String(url).includes("/viewer")
      ? Response.json({ role: "ADMIN", accountScope: account })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  expect(await screen.findByRole("button", { name: "核对创建结果" })).toBeTruthy();
  account = "account-B";
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "核对创建结果" })).toBeNull());
  expect(((await screen.findByLabelText("批次名称")) as HTMLInputElement).value).toBe("");
  expect(sessionStorage.getItem("pelican:create:account-A")).toContain("old-account");
});
it("does not present a completed batch's empty pending quote as its actual cost or a run blocker", async () => {
  mocks("ADMIN", {
    ...admin,
    batches: [
      {
        ...batch,
        status: "COMPLETE",
        estimatedCostUsd: 0,
        estimatedTokens: 0,
        blockedReason: "BATCH_NOT_RUNNABLE",
        canPublish: true,
      },
    ],
  });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  expect(await screen.findByRole("button", { name: "发布完整批次" })).toBeTruthy();
  expect(screen.queryByText(/USD 0.0000/)).toBeNull();
  expect(screen.queryByText(/本批次受预算、配置或执行状态限制/)).toBeNull();
  expect(screen.queryByText("待执行样本预计费用")).toBeNull();
  expect(screen.getByText("调用与用量记录")).toBeTruthy();
});
it("labels an estimate and run blocker as applying to queued samples only", async () => {
  mocks("ADMIN", {
    ...admin,
    batches: [
      {
        ...batch,
        status: "DRAFT",
        samples: [{ ...sample, callStatus: "QUEUED", previewStatus: "PENDING" }],
        blockedReason: "BUDGET_REQUIRED",
      },
    ],
  });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  expect(await screen.findByText("待执行样本预计费用")).toBeTruthy();
  expect(screen.getByText("USD 0.0300")).toBeTruthy();
  expect(screen.getByText("当前无法开始执行")).toBeTruthy();
  expect(screen.getByText(/当前受预算、配置或执行状态限制/)).toBeTruthy();
});
it("requires fresh consent when a rerun changes the frozen budget fingerprint", async () => {
  const initial = {
    ...batch,
    status: "DRAFT",
    canRun: true,
    samples: [{ ...sample, callStatus: "QUEUED" }],
  };
  const completed = { ...batch, status: "COMPLETE", canRun: false };
  const fetcher = mocks("ADMIN", { ...admin, batches: [initial] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return base(url, init);
    const input = JSON.parse(String(init.body));
    return Response.json({
      batch:
        input.action === "run"
          ? completed
          : {
              ...completed,
              status: "DRAFT",
              canRun: true,
              budgetFingerprint: "new-budget-for-rerun",
              samples: [
                sample,
                { ...sample, id: "rerun-sample", callStatus: "QUEUED", rerunOf: sample.id },
              ],
            },
    });
  });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /确认本批预计费用/ }));
  fireEvent.click(screen.getByRole("button", { name: "发起真实测试" }));
  fireEvent.click(await screen.findByRole("button", { name: "准备独立重跑样本" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "确认这是新的独立收费意图" }));
  fireEvent.click(screen.getByRole("button", { name: "创建重跑样本" }));
  const run = await screen.findByRole("button", { name: "发起真实测试" });
  expect(run.hasAttribute("disabled")).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: /确认本批预计费用/ }) as HTMLInputElement).checked,
  ).toBe(false);
});
it("revalidates a static thumbnail denial instead of leaving a withdrawn preview visible", async () => {
  const fetcher = mocks();
  const base = fetcher.getMockImplementation()!;
  let withdrawn = false;
  fetcher.mockImplementation(async (url, init) =>
    String(url).includes("/api/pelican?")
      ? Response.json({
          ...listing,
          batches: withdrawn
            ? []
            : [{ ...batch, samples: [{ ...sample, previewStatus: "STATIC" }] }],
        })
      : base(url, init),
  );
  render(<PelicanPage locale="zh-CN" />);
  fireEvent.click(await screen.findByRole("button", { name: /打开作品/ }));
  withdrawn = true;
  fireEvent.error(screen.getByRole("dialog").querySelector("img")!);
  await screen.findByText("还没有已发布作品");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("explicitly resubmits the immutable creation after GET confirms the original request is absent", async () => {
  const fetcher = mocks("ADMIN");
  const base = fetcher.getMockImplementation()!;
  let posts = 0;
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return base(url, init);
    if (++posts === 1) throw new TypeError("network before request arrived");
    return Response.json({ batch: { ...batch, status: "DRAFT" } });
  });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /DeepSeek-V4.1-Flash-1017/ }));
  fireEvent.change(screen.getByLabelText("批次名称"), { target: { value: "保留同一创建请求" } });
  fireEvent.click(screen.getByRole("button", { name: "创建批次并查看预算" }));
  await screen.findByText(/创建结果待核对，请先核对此请求/);
  fireEvent.click(screen.getByRole("button", { name: "核对创建结果" }));
  fireEvent.click(await screen.findByRole("button", { name: "重新提交同一创建请求" }));
  await screen.findByText(/批次已创建，请确认预计预算/);
  const mutations = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(mutations).toHaveLength(2);
  expect(mutations[0][1]?.body).toBe(mutations[1][1]?.body);
  expect(sessionStorage.getItem("pelican:create:account-A")).toBeNull();
});
it("allows a confirmed same-batch retry only after GET confirms every sample remains queued", async () => {
  const queued = {
    ...batch,
    status: "DRAFT",
    canRun: true,
    samples: [{ ...sample, callStatus: "QUEUED" }],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [queued] });
  const base = fetcher.getMockImplementation()!;
  let posts = 0;
  fetcher.mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return base(url, init);
    if (++posts === 1) throw new TypeError("network before request arrived");
    return Response.json({ batch: { ...batch, status: "RUNNING", canRun: false } });
  });
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /确认本批预计费用/ }));
  fireEvent.click(screen.getByRole("button", { name: "发起真实测试" }));
  await screen.findByText(/操作结果待核对/);
  expect(screen.queryByRole("button", { name: "核对后重新确认执行" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  const retry = await screen.findByRole("button", { name: "核对后重新确认执行" });
  expect(retry.hasAttribute("disabled")).toBe(true);
  expect(posts).toBe(1);
  fireEvent.click(screen.getByRole("checkbox", { name: "确认当前预算，并重新授权同一批次执行" }));
  fireEvent.click(retry);
  await waitFor(() => expect(posts).toBe(2));
  const mutations = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(mutations[0][0]).toBe(mutations[1][0]);
  expect(mutations[0][1]?.body).toBe(mutations[1][1]?.body);
});
it("keeps a batch selected on a later page without returning to the first page", async () => {
  const older = {
    ...batch,
    id: "page2-first",
    samples: [{ ...sample, id: "page2-first-sample", modelName: "Page 2 first" }],
  };
  const older2 = {
    ...batch,
    id: "page2-second",
    title: "Page 2 second batch",
    samples: [{ ...sample, id: "page2-second-sample", modelName: "Page 2 second" }],
  };
  const fetcher = mocks();
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url).includes("/api/pelican?")
      ? Response.json({
          ...listing,
          batches: String(url).includes("page=2") ? [older, older2] : [batch],
          hasMore: !String(url).includes("page=2"),
        })
      : base(url, init),
  );
  render(<PelicanPage locale="zh-CN" />);
  fireEvent.click(await screen.findByRole("button", { name: "本期对比" }));
  fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
  fireEvent.change(await screen.findByLabelText("选择批次"), { target: { value: "page2-second" } });
  expect(await screen.findByRole("button", { name: /打开作品.*Page 2 second/ })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("page=1"))).toHaveLength(2);
});
it("requires confirmation before ending undispatched samples without hiding dispatched results", async () => {
  const running = { ...batch, status: "RUNNING", samples: [{ ...sample, callStatus: "PENDING" }] };
  const fetcher = mocks("ADMIN", { ...admin, batches: [running] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST"
      ? Response.json({
          batch: { ...running, status: "COMPLETE", samples: [{ ...sample, callStatus: "FAILED" }] },
        })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByText("处理未派发请求"));
  const cancel = await screen.findByRole("button", { name: "结束未派发样本" });
  expect(cancel.hasAttribute("disabled")).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "只结束尚未发送的请求，已发送的待核对结果会保留" }),
  );
  fireEvent.click(cancel);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([, init]) =>
          init?.body === JSON.stringify({ action: "cancel-undispatched", confirmed: true }),
      ),
    ).toBe(true),
  );
  expect((await screen.findAllByText("调用失败")).length).toBeGreaterThan(0);
});
it("manually resubmits an absent rerun preparation using its original immutable request without running", async () => {
  const completed = { ...batch, status: "COMPLETE" };
  const fetcher = mocks("ADMIN", { ...admin, batches: [completed] });
  const base = fetcher.getMockImplementation()!;
  let posts = 0;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).includes("rerunRequestKey=")) return Response.json({ ...admin, batches: [] });
    if (init?.method !== "POST") return base(url, init);
    if (++posts === 1) throw new TypeError("network before request arrived");
    return Response.json({
      batch: {
        ...completed,
        status: "DRAFT",
        canRun: true,
        budgetFingerprint: "rerun-budget",
        samples: [
          sample,
          { ...sample, id: "recovered-rerun", rerunOf: sample.id, callStatus: "QUEUED" },
        ],
      },
    });
  });
  const view = await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("button", { name: "准备独立重跑样本" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "确认这是新的独立收费意图" }));
  fireEvent.click(screen.getByRole("button", { name: "创建重跑样本" }));
  await screen.findByText(/重跑准备结果待核对/);
  const originalReceipt = sessionStorage.getItem("pelican:action:account-A");
  expect(originalReceipt).toBeTruthy();
  view.unmount();
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  expect(await screen.findByText(/重跑准备待确认，尚未授权派发/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重新提交同一重跑准备请求" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  fireEvent.click(await screen.findByRole("button", { name: "重新提交同一重跑准备请求" }));
  await waitFor(() => expect(posts).toBe(2));
  const mutations = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(mutations[0][0]).toBe(mutations[1][0]);
  expect(mutations[0][1]?.body).toBe(mutations[1][1]?.body);
  const input = JSON.parse(String(mutations[1][1]?.body));
  expect(input).toMatchObject({ action: "rerun", sampleId: sample.id, confirmed: true });
  expect(input.requestKey).toBe(JSON.parse(originalReceipt!).requestKey);
  expect(sessionStorage.getItem("pelican:action:account-A")).toBeNull();
  expect(screen.getByRole("button", { name: "发起真实测试" }).hasAttribute("disabled")).toBe(true);
});
it("opens on model history with horizontal model rails and explicit scroll controls", async () => {
  const fetcher = mocks();
  render(<PelicanPage locale="zh-CN" />);
  await screen.findByRole("button", { name: /打开作品/ });
  expect(screen.getByRole("button", { name: "模型历史" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "Frozen model name 向后浏览" })).toBeTruthy();
  expect(fetcher.mock.calls.some(([u]) => String(u).includes("view=history"))).toBe(true);
});
it("keeps creation folded and exposes management filters without creating requests", async () => {
  const fetcher = mocks("ADMIN");
  render(<PelicanPage locale="zh-CN" manage />);
  const create = await screen.findByText("新建测试");
  expect(create.closest("details")?.open).toBe(false);
  fireEvent.change(screen.getByLabelText("搜索测试"), { target: { value: "needle" } });
  fireEvent.change(screen.getByLabelText("执行状态"), { target: { value: "failed" } });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([u]) => String(u).includes("query=needle") && String(u).includes("status=failed"),
      ),
    ).toBe(true),
  );
  expect(fetcher.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
});

it("polls an active run without redispatching and stops the exact sample", async () => {
  const running = {
    ...batch,
    status: "RUNNING",
    samples: [
      {
        ...sample,
        callStatus: "PENDING",
        startedAt: "2026-11-11T01:00:00Z",
        canStop: true,
        hasThumbnail: false,
      },
    ],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [running] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST"
      ? Response.json({
          batch: {
            ...running,
            status: "COMPLETE",
            samples: [{ ...sample, callStatus: "UNKNOWN", canStop: false, stopRequested: true }],
          },
        })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  expect(await screen.findByText("状态自动更新中")).toBeTruthy();
  await waitFor(
    () =>
      expect(
        fetcher.mock.calls.filter(([u]) => String(u).includes("/admin?")).length,
      ).toBeGreaterThan(1),
    { timeout: 3000 },
  );
  expect(screen.getByRole("region", { name: "当前批次详情" })).toBeTruthy();
  expect(fetcher.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "停止此样本" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([, i]) =>
          i?.body === JSON.stringify({ action: "stop", confirmed: true, sampleId: sample.id }),
      ),
    ).toBe(true),
  );
  expect(screen.getByText(/停止不保证供应商停止计费/)).toBeTruthy();
});
it("shows failure codes and deletes only the eligible failed record", async () => {
  const failed = {
    ...sample,
    callStatus: "FAILED",
    hasThumbnail: false,
    errorCode: "PROVIDER_DOWN",
    errorMessage: "Provider unavailable",
    canDelete: true,
  };
  const fetcher = mocks("ADMIN", {
    ...admin,
    batches: [{ ...batch, status: "COMPLETE", samples: [failed] }],
  });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST"
      ? Response.json({ batch: { ...batch, status: "COMPLETE", samples: [] } })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  expect(screen.getByText("PROVIDER_DOWN")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "删除失败记录" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除此失败记录" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([, i]) =>
          i?.body ===
          JSON.stringify({ action: "delete-failed", confirmed: true, sampleId: sample.id }),
      ),
    ).toBe(true),
  );
  expect(screen.queryByText("PROVIDER_DOWN")).toBeNull();
});
it("loads complete batch scope before paid confirmation despite listing filters", async () => {
  const draft = {
    ...batch,
    status: "DRAFT",
    canRun: true,
    publishedAt: null,
    samples: [{ ...sample, callStatus: "QUEUED" }],
  };
  const other = {
    ...sample,
    id: "hidden-model",
    modelName: "Hidden queued model",
    callStatus: "QUEUED",
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [draft] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url) === "/api/pelican/admin/batch-1"
      ? Response.json({ batch: { ...draft, samples: [...draft.samples, other] } })
      : base(url, init),
  );
  render(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(await screen.findByRole("button", { name: /管理批次：/ }));
  const dialog = await screen.findByRole("dialog", { name: "当前批次详情" });
  expect(await screen.findByText(/本次执行范围：2 个样本/)).toBeTruthy();
  expect(dialog.textContent).toContain("Hidden queued model");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("labels zero generation deadline as unlimited in preview settings", async () => {
  const fetcher = mocks();
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url).startsWith("/api/pelican?")
      ? Response.json({
          ...listing,
          batches: [{ ...batch, samples: [{ ...sample, timeoutMs: 0 }] }],
        })
      : base(url, init),
  );
  render(<PelicanPage locale="zh-CN" />);
  fireEvent.click(await screen.findByRole("button", { name: /打开作品/ }));
  fireEvent.click(await screen.findByText("本次条件与预览说明"));
  expect(await screen.findByText("不限等待时间")).toBeTruthy();
});

it("shows recorded start time and elapsed status while a result is still running", async () => {
  render(
    <SampleCard
      sample={{
        ...sample,
        callStatus: "PENDING",
        generatedAt: null,
        startedAt: "2026-11-11T01:00:00Z",
        latencyMs: null,
        hasThumbnail: false,
      }}
      locale="zh-CN"
      onOpen={() => {}}
    />,
  );
  expect(screen.getByText("2026/11/11 09:00:00")).toBeTruthy();
  expect(screen.queryByText("耗时未记录")).toBeNull();
});
it("stops polling after closing a running batch that no longer matches the visible filter", async () => {
  const running = {
    ...batch,
    status: "RUNNING",
    samples: [{ ...sample, callStatus: "PENDING", canStop: true }],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [running] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    String(url).includes("status=succeeded")
      ? Response.json({ ...admin, batches: [] })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  fireEvent.change(screen.getByLabelText("执行状态"), { target: { value: "succeeded" } });
  await screen.findByText("还没有测试批次。请在上方选择已配置模型，创建后查看预算。");
  const count = fetcher.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(fetcher.mock.calls.length).toBe(count);
});

it("uses distinct tone-coded badges for execution and preview states", () => {
  const ready = render(
    <SampleCard sample={sample} locale="zh-CN" onOpen={() => {}} showExecution />,
  );
  const executed = screen.getByText("已成功").closest(".pelican-status-badge")!;
  expect(executed.getAttribute("data-tone")).toBe("success");
  expect(executed.getAttribute("data-status")).toBe("succeeded");
  const previewed = screen.getByText("动画可预览").closest(".pelican-status-badge")!;
  expect(previewed.getAttribute("data-tone")).toBe("success");
  ready.unmount();

  const queued = render(
    <SampleCard
      sample={{ ...sample, callStatus: "QUEUED", previewStatus: "PENDING" }}
      locale="zh-CN"
      onOpen={() => {}}
      showExecution
    />,
  );
  const waiting = screen.getByText("待执行").closest(".pelican-status-badge")!;
  expect(waiting.getAttribute("data-tone")).toBe("neutral");
  queued.unmount();

  render(
    <SampleCard
      sample={{ ...sample, callStatus: "FAILED", previewStatus: "INVALID" }}
      locale="zh-CN"
      onOpen={() => {}}
      showExecution
    />,
  );
  const failed = screen.getByText("调用失败").closest(".pelican-status-badge")!;
  expect(failed.getAttribute("data-tone")).toBe("danger");
  expect(failed.getAttribute("data-status")).toBe("failed");
});
it("explains why an unrun batch cannot start and soft-deletes only that owned record", async () => {
  const draft = {
    ...batch,
    status: "DRAFT" as const,
    publishedAt: null,
    canRun: false,
    canDelete: true,
    blockedReason: "MODEL_QUOTA_EXCEEDED",
    runBlock: {
      code: "MODEL_QUOTA_EXCEEDED",
      modelName: "Frozen model name",
      requiredTokens: 65894,
      remainingTokens: 10000,
      requiredCostUsd: 0.0788,
      remainingCostUsd: 0.24,
      resetAt: "2026-11-12T00:00:00.000Z",
    },
    samples: [{ ...sample, callStatus: "QUEUED" as const, previewStatus: "PENDING" as const }],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [draft] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST" ? Response.json({ batch: draft }) : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  const region = screen.getByRole("region", { name: "当前批次详情" });
  expect(region.querySelector(".pelican-batch-status")?.getAttribute("data-tone")).toBe("neutral");
  expect(region.textContent).toContain("当前无法开始执行");
  expect(screen.getByText(/当前可用 10,000 tokens/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "删除测试记录" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除此测试记录" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([, i]) => i?.body === JSON.stringify({ action: "delete-batch", confirmed: true }),
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText(/测试记录已从管理列表移除/)).toBeTruthy();
});
it("offers an explicit final stop for an interrupted run that has no live worker", async () => {
  const stuck = {
    ...batch,
    status: "RUNNING" as const,
    canRun: false,
    canDelete: false,
    samples: [
      {
        ...sample,
        callStatus: "UNKNOWN" as const,
        stopRequested: true,
        interrupted: true,
        canStop: true,
        errorCode: "PELICAN_RUN_INTERRUPTED",
      },
    ],
  };
  const fetcher = mocks("ADMIN", { ...admin, batches: [stuck] });
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    init?.method === "POST"
      ? Response.json({ batch: { ...stuck, status: "COMPLETE", samples: [] } })
      : base(url, init),
  );
  await renderAdmin(<PelicanPage locale="zh-CN" manage />);
  fireEvent.click(screen.getByRole("button", { name: "结束中断执行" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([, i]) =>
          i?.body === JSON.stringify({ action: "stop", confirmed: true, sampleId: sample.id }),
      ),
    ).toBe(true),
  );
});
