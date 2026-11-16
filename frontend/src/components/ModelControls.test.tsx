// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CATALOG, type ModelSelection } from "@/lib/model-catalog";
import { ModelControls, ModelResultEvidence, useModelSelection } from "./ModelControls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Harness({
  disabled = false,
  initial,
  modelKeys,
}: {
  disabled?: boolean;
  initial?: ModelSelection;
  modelKeys?: readonly string[];
}) {
  const c = useModelSelection(initial);
  return (
    <>
      <ModelControls control={c} locale="zh-CN" disabled={disabled} modelKeys={modelKeys} />
      <button disabled={!c.canRun}>Run</button>
      <output>{JSON.stringify(c.selection)}</output>
    </>
  );
}
const models = MODEL_CATALOG.map((m) => ({
  key: m.key,
  configured: true,
  maxOutputTokens: 1200,
  timeoutMs: m.provider === "siliconflow" ? 300000 : 30000,
}));
describe("model settings", () => {
  it("can restrict a workflow to its supported model while retaining budget controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL) => {
        void _url;
        return Response.json({ models });
      }),
    );
    render(<Harness modelKeys={["deepseek-direct"]} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByLabelText("模型")).toBeNull();
    expect(screen.getByLabelText("输出 token 预算（含思考）")).toBeTruthy();
  });
  it("keeps advanced settings collapsed and displays a fixed maximum instead of a low-budget selector", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
      void _url;
      return Response.json({ models });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness initial={{ maxOutputTokens: 128 }} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByText(/^高级设置/).closest("details")!.open).toBe(false);
    expect(screen.getByLabelText("输出 token 预算（含思考）").textContent).toBe("1200 tokens");
    expect(screen.getByText(/^高级设置/).textContent).toContain("模型最高上限");
    expect(screen.getByLabelText("输出 token 预算（含思考）").tagName).toBe("OUTPUT");
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/models")).toHaveLength(
      1,
    );
    expect(
      fetchMock.mock.calls.every(
        (call) =>
          String(call[0]) === "/api/models" ||
          String(call[0]).startsWith("/api/models/availability?"),
      ),
    ).toBe(true);
  });
  it("offers only documented per-model strengths and resets an incompatible previous tier", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url;
      void _init;
      return Response.json({ models });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByText(/^高级设置/));
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "deepseek-ai/DeepSeek-V4-Pro" },
    });
    const strength = screen.getByLabelText("推理强度");
    expect([...strength.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "off",
      "high",
      "max",
    ]);
    fireEvent.change(strength, { target: { value: "max" } });
    expect(screen.getByText(/"strength":"max"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "zai-org/GLM-5.3" } });
    expect((strength as HTMLSelectElement).value).toBe("default");
    expect(strength.hasAttribute("disabled")).toBe(false);
    expect([...strength.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "default",
      "low",
      "high",
      "max",
    ]);
    fireEvent.change(strength, { target: { value: "low" } });
    expect(screen.getByText(/"strength":"low"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "zai-org/GLM-5.3-Flash" } });
    expect(strength.hasAttribute("disabled")).toBe(false);
    expect([...strength.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "default",
      "low",
      "high",
      "max",
    ]);
    expect(screen.queryByText(/尚未核实该模型专属强度档位/)).toBeNull();
    fireEvent.change(strength, { target: { value: "high" } });
    expect(screen.getByText(/"strength":"high"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "tencent/Hy4-preview" } });
    expect([...strength.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "default",
      "off",
      "high",
    ]);
    expect(screen.getByText(/等待上限: 300s/)).toBeTruthy();
    expect(screen.getByText(/超时不代表供应商已停止或未计费/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "deepseek-direct" } });
    expect(screen.getByText(/等待上限: 30s/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/models")).toHaveLength(
      1,
    );
    expect(
      fetchMock.mock.calls.every(
        (call) =>
          String(call[0]) === "/api/models" ||
          String(call[0]).startsWith("/api/models/availability?"),
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/models");
  });
  it("does not enable calls when configuration fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "UNAVAILABLE" }, { status: 503 })),
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByText(/模型配置暂不可用/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
  });
  it("honors the server output ceiling and disables unconfigured options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          models: models.map((m, i) => ({ ...m, configured: i !== 2, maxOutputTokens: 512 })),
        }),
      ),
    );
    render(<Harness initial={{ maxOutputTokens: 1200 }} />);
    await waitFor(() =>
      expect(screen.getByLabelText("输出 token 预算（含思考）").textContent).toBe("512 tokens"),
    );
    fireEvent.click(screen.getByText(/^高级设置/));
    expect(screen.getByRole("option", { name: /Hy4-preview/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("option", { name: "1200 tokens" })).toBeNull();
  });
  it("keeps task-based output automatic through configuration and model changes", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
      void _url;
      return Response.json({ models });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.getByText(/^高级设置/).textContent).toContain("模型最高上限");
    expect(screen.getByText(/"modelKey":"deepseek-direct"/).textContent).not.toContain(
      "maxOutputTokens",
    );
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "zai-org/GLM-5.3" } });
    expect(screen.getByLabelText("正文输出上限（不含思考 tokens）").textContent).toBe(
      "1200 tokens",
    );
    expect(screen.getByText(/"modelKey":"zai-org\/GLM-5.3"/).textContent).not.toContain(
      "maxOutputTokens",
    );
    expect(fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/models")).toHaveLength(
      1,
    );
    expect(
      fetchMock.mock.calls.every(
        (call) =>
          String(call[0]) === "/api/models" ||
          String(call[0]).startsWith("/api/models/availability?"),
      ),
    ).toBe(true);
  });
  it("preserves frozen historical limits while new selections use the model maximum", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL) => {
        void _url;
        return Response.json({ models });
      }),
    );
    const view = render(<Harness disabled initial={{ maxOutputTokens: 128 }} />);
    await waitFor(() =>
      expect(screen.getByLabelText("输出 token 预算（含思考）").textContent).toBe("128 tokens"),
    );
    view.rerender(<Harness initial={{ maxOutputTokens: 128 }} />);
    expect(screen.getByLabelText("输出 token 预算（含思考）").textContent).toBe("1200 tokens");
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "zai-org/GLM-5.3" } });
    expect(screen.getByLabelText("正文输出上限（不含思考 tokens）").textContent).toBe(
      "1200 tokens",
    );
  });
  it("displays reasoning as a subset, not an added total", () => {
    render(
      <ModelResultEvidence
        locale="zh-CN"
        result={{
          provider: "siliconflow",
          resolvedModel: "GLM",
          strength: "default",
          usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50, reasoningTokens: 25 },
        }}
      />,
    );
    expect(screen.getByText(/20 input \+ 30 output = 50 tokens · 其中推理 25/)).toBeTruthy();
  });
});
