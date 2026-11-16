import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CATALOG,
  modelOutputLimit,
  validModelSelection,
  type ModelStrength,
} from "@/lib/model-catalog";
import { readModelConfig, publicModelConfig } from "./model-config";
import { generateWithChatModel } from "./deepseek-provider";
import type { LiveModelConfig } from "./model-types";
import { calculateUsageCostUsd } from "./model-pricing";

const env = {
  PROMPTMASTER_MODEL_MODE: "live",
  SILICONFLOW_API_KEY: "synthetic-secret-not-real",
  PROMPTMASTER_MODEL_MAX_RETRIES: "5",
};
const modelKey = "deepseek-ai/DeepSeek-V4-Pro";
const input = { goal: "测试实施计划", taskType: "Coding" as const, locale: "zh-CN" as const };
function config(strength: ModelStrength = "off", key = modelKey): LiveModelConfig {
  return readModelConfig(env, { modelKey: key, strength }) as LiveModelConfig;
}
function payload() {
  return {
    id: "synthetic-request",
    model: modelKey,
    choices: [{ message: { content: "真实协议模拟结果" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 30,
      total_tokens: 50,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 25 },
    },
  };
}
afterEach(() => vi.useRealTimers());

function delayedText(signal: AbortSignal, milliseconds: number) {
  return new Promise<string>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(JSON.stringify(payload()));
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

describe("SiliconFlow registry and adapter (no network)", () => {
  it.each(MODEL_CATALOG.filter((m) => m.provider === "siliconflow"))(
    "configures exact $key, without changing shared ceilings",
    (m) => {
      const c = readModelConfig(env, { modelKey: m.key }) as LiveModelConfig;
      expect(c).toMatchObject({
        provider: "siliconflow",
        model: m.model,
        productVersion: m.model,
        maxRetries: 0,
        maxOutputTokens: modelOutputLimit(m.key),
        timeoutMs: 300000,
        strength: m.defaultStrength,
      });
      expect(c.baseUrl).toBe("https://api.siliconflow.cn/v1");
      expect(JSON.stringify(publicModelConfig(c))).not.toContain(env.SILICONFLOW_API_KEY);
      expect(c.dailyCostLimitUsd).toBe(6);
    },
  );
  it("uses a dedicated timeout without inheriting the legacy 30s setting", () => {
    expect(
      readModelConfig({ ...env, PROMPTMASTER_MODEL_TIMEOUT_MS: "30000" }, { modelKey }),
    ).toMatchObject({ timeoutMs: 300000, maxRetries: 0 });
    for (const timeout of ["1000", "180000", "600000"])
      expect(
        readModelConfig({ ...env, SILICONFLOW_MODEL_TIMEOUT_MS: timeout }, { modelKey }),
      ).toMatchObject({ timeoutMs: Number(timeout), maxRetries: 0 });
    for (const timeout of ["999", "600001", "NaN", "Infinity", "30000.1"])
      expect(() =>
        readModelConfig({ ...env, SILICONFLOW_MODEL_TIMEOUT_MS: timeout }, { modelKey }),
      ).toThrow("SILICONFLOW_MODEL_TIMEOUT_MS must be an integer");
  });
  it.each(["headers", "body"])(
    "allows a simulated 45s %s response beyond the old 30s deadline",
    async (phase) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        signal = init!.signal!;
        if (phase === "headers") return new Response(await delayedText(signal, 45000));
        const response = Response.json(payload());
        vi.spyOn(response, "text").mockImplementation(() => delayedText(signal!, 45000));
        return response;
      });
      const completion = generateWithChatModel(config(), input, { fetchImpl });
      const assertion = expect(completion).resolves.toMatchObject({
        content: "真实协议模拟结果",
        usage: { totalTokens: 50 },
      });
      await vi.advanceTimersByTimeAsync(30001);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(14999);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["headers", "body"])(
    "still aborts stalled %s at the configured deadline without retrying",
    async (phase) => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (phase === "headers") return new Response(await delayedText(init!.signal!, 400000));
        const response = Response.json(payload());
        vi.spyOn(response, "text").mockImplementation(() => delayedText(init!.signal!, 400000));
        return response;
      });
      const sleep = vi.fn();
      // Even an accidentally retry-enabled config must not re-send a timed-out call.
      const completion = generateWithChatModel({ ...config(), maxRetries: 2 }, input, {
        fetchImpl,
        sleep,
      });
      const assertion = expect(completion).rejects.toMatchObject({
        code: "MODEL_REQUEST_TIMEOUT",
        httpStatus: 504,
        retryable: false,
        message: expect.stringContaining("300s timeout"),
      });
      await vi.advanceTimersByTimeAsync(300000);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("still honors caller cancellation during the longer wait", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Response(await delayedText(init!.signal!, 45000)),
    );
    const completion = generateWithChatModel(
      config(),
      { ...input, signal: caller.signal },
      {
        fetchImpl,
      },
    );
    const assertion = expect(completion).rejects.toMatchObject({
      code: "MODEL_REQUEST_CANCELLED",
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(31000);
    caller.abort();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects unknown models, fabricated tiers, credentials and excessive output", () => {
    for (const selection of [
      { modelKey: "other" },
      { modelKey, strength: "low" },
      { modelKey: "zai-org/GLM-5.3", strength: "off" },
      { apiKey: "spoof" },
      { endpoint: "https://evil.test" },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1200.1 },
    ])
      expect(validModelSelection(selection)).toBe(false);
    expect(readModelConfig(env, { modelKey, maxOutputTokens: 1201 })).toMatchObject({
      maxOutputTokens: modelOutputLimit(modelKey),
    });
    expect(config("off").reasoningTokenReserve).toBe(0);
    expect(config("max").reasoningTokenReserve).toBe(32768);
    expect(() =>
      readModelConfig({ ...env, SILICONFLOW_BASE_URL: "https://evil.test/v1" }, { modelKey }),
    ).toThrow("approved");
    expect(() => readModelConfig({ ...env, SILICONFLOW_API_KEY: "" }, { modelKey })).toThrow(
      "required",
    );
    expect(readModelConfig({ ...env, PROMPTMASTER_MODEL_MODE: "disabled" }, { modelKey })).toEqual({
      mode: "DISABLED",
    });
  });
  it.each(["off", "high", "max"] as const)(
    "sends the documented %s fields and parses reasoning without double counting",
    async (strength) => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
        void _url;
        void _init;
        return Response.json(payload());
      });
      const result = await generateWithChatModel(config(strength), input, { fetchImpl });
      const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(fetchImpl.mock.calls[0][0]).toBe("https://api.siliconflow.cn/v1/chat/completions");
      expect(body).toMatchObject({
        model: modelKey,
        max_tokens: modelOutputLimit(modelKey),
        enable_thinking: strength !== "off",
        stream: false,
      });
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBe(strength === "off" ? undefined : strength);
      expect(body.thinking_budget).toBe(strength === "off" ? undefined : 32768);
      expect(result.usage).toEqual({
        promptTokens: 20,
        completionTokens: 30,
        totalTokens: 50,
        reasoningTokens: 25,
        promptCacheHitTokens: 5,
      });
      expect(
        calculateUsageCostUsd(
          {
            id: "p",
            pricingWindow: "PEAK",
            inputCacheHitUsdPerMillion: 0.2,
            inputCacheMissUsdPerMillion: 2.4,
            outputUsdPerMillion: 4.8,
            sourceUrl: "",
          },
          result.usage,
        ),
      ).toBe(0.000181);
    },
  );
  it.each(["zai-org/GLM-5.3-Flash", "tencent/Hy4-preview", "zai-org/GLM-5.3"])(
    "does not invent reasoning overrides for %s",
    async (key) => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
        void _url;
        void _init;
        return Response.json(payload());
      });
      await generateWithChatModel(config("default", key), input, { fetchImpl });
      const b = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      for (const field of ["thinking", "enable_thinking", "reasoning_effort", "thinking_budget"])
        expect(b).not.toHaveProperty(field);
    },
  );
  it.each(["low", "high", "max"] as const)(
    "sends GLM-5.3 %s without unsupported thinking controls",
    async (strength) => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
        void _url;
        void _init;
        return Response.json({ ...payload(), model: "zai-org/GLM-5.3" });
      });
      await generateWithChatModel(config(strength, "zai-org/GLM-5.3"), input, { fetchImpl });
      const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(body).toMatchObject({ model: "zai-org/GLM-5.3", reasoning_effort: strength });
      for (const field of ["thinking", "enable_thinking", "thinking_budget"])
        expect(body).not.toHaveProperty(field);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["low", "high", "max"] as const)(
    "sends GLM-5.3-Flash %s using advertised reasoning effort only",
    async (strength) => {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
        void _url;
        void _init;
        return Response.json({ ...payload(), model: "zai-org/GLM-5.3-Flash" });
      });
      await generateWithChatModel(config(strength, "zai-org/GLM-5.3-Flash"), input, { fetchImpl });
      const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        model: "zai-org/GLM-5.3-Flash",
        reasoning_effort: strength,
      });
      for (const field of ["thinking", "enable_thinking", "thinking_budget"])
        expect(body).not.toHaveProperty(field);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ["off", "no_think"],
    ["high", "high"],
  ] as const)("maps Hy4-preview %s to reasoning_effort=%s", async (strength, effort) => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      void _url;
      void _init;
      return Response.json({ ...payload(), model: "tencent/Hy4-preview" });
    });
    await generateWithChatModel(config(strength, "tencent/Hy4-preview"), input, { fetchImpl });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: "tencent/Hy4-preview", reasoning_effort: effort });
    for (const field of ["thinking", "enable_thinking", "thinking_budget"])
      expect(body).not.toHaveProperty(field);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([401, 402, 422, 429, 500, 503])(
    "does not retry HTTP %s or leak secrets",
    async (status) => {
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: { message: `Bearer ${env.SILICONFLOW_API_KEY}` } }, { status }),
      );
      const error = await generateWithChatModel(config(), input, { fetchImpl }).catch((e) => e);
      expect(error.code).toMatch(/^SILICONFLOW_/);
      expect(error.message).not.toContain(env.SILICONFLOW_API_KEY);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
  it("fails closed on invalid reasoning usage, missing text and cancellation", async () => {
    for (const p of [
      {
        ...payload(),
        usage: { ...payload().usage, completion_tokens_details: { reasoning_tokens: 31 } },
      },
      { ...payload(), choices: [] },
      { ...payload(), usage: { ...payload().usage, total_tokens: 75 } },
    ])
      await expect(
        generateWithChatModel(config(), input, { fetchImpl: async () => Response.json(p) }),
      ).rejects.toMatchObject({ code: "SILICONFLOW_INVALID_RESPONSE" });
    const fetchImpl = vi.fn();
    await expect(
      generateWithChatModel(config(), { ...input, signal: AbortSignal.abort() }, { fetchImpl }),
    ).rejects.toMatchObject({ code: "MODEL_REQUEST_CANCELLED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
