import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRemoteSnapshot,
  fetchLiveModelQuota,
  generateLivePrompt,
  optimizeLivePrompt,
  runLivePlayground,
} from "./api-client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("quota client", () => {
  it("rejects partial or null data rather than presenting zero usage", async () => {
    for (const data of [null, { scope: "USER", dailyTokenLimit: 100000 }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
      expect(await fetchLiveModelQuota()).toMatchObject({
        kind: "unavailable",
        code: "INVALID_QUOTA_RESPONSE",
      });
    }
  });
  it("retains explicit quota service errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "MODEL_PRICING_UNAVAILABLE" }, { status: 503 })),
    );
    expect(await fetchLiveModelQuota()).toMatchObject({
      kind: "unavailable",
      code: "MODEL_PRICING_UNAVAILABLE",
    });
  });
});

describe("live generation client", () => {
  it("parses a complete live response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          executionMode: "LIVE",
          executionId: "mex_01",
          promptId: "prm_01",
          versionId: "ver_01",
          title: "Launch checklist",
          taskType: "Business",
          content: "Act as a launch planner.",
          provider: "deepseek",
          requestedModel: "deepseek-flash",
          resolvedModel: "deepseek-flash",
          productVersion: "DeepSeek-V4.1-Flash-1017",
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          latencyMs: 500,
        }),
      ),
    );
    await expect(
      generateLivePrompt({ goal: "Launch checklist", taskType: "Business", locale: "en" }),
    ).resolves.toMatchObject({
      kind: "ready",
      data: { executionMode: "LIVE", executionId: "mex_01", promptId: "prm_01" },
    });
  });

  it("keeps explicit live failures instead of fabricating a simulated result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: "DEEPSEEK_AUTHENTICATION_FAILED",
            message: "DeepSeek authentication failed. Check the server-side API key.",
            executionId: "mex_failed",
          },
          { status: 502 },
        ),
      ),
    );
    await expect(
      generateLivePrompt({ goal: "Launch checklist", taskType: "Business", locale: "en" }),
    ).resolves.toEqual({
      kind: "unavailable",
      code: "DEEPSEEK_AUTHENTICATION_FAILED",
      message: "DeepSeek authentication failed. Check the server-side API key.",
      executionId: "mex_failed",
    });
  });

  it("keeps purpose-specific live responses explicit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          executionMode: "LIVE",
          purpose: "OPTIMIZATION",
          executionId: "mex_opt",
          promptId: "prm_01",
          versionId: "ver_01",
          content: "Improved prompt",
          provider: "deepseek",
          requestedModel: "deepseek-flash",
          resolvedModel: "deepseek-flash",
          productVersion: "DeepSeek-V4.1-Flash-1017",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          latencyMs: 500,
        }),
      ),
    );
    await expect(
      optimizeLivePrompt({ promptId: "prm_01", versionId: "ver_01", locale: "en" }),
    ).resolves.toMatchObject({ kind: "ready", data: { purpose: "OPTIMIZATION" } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          executionMode: "LIVE",
          purpose: "PLAYGROUND",
          executionId: "mex_play",
          promptId: "prm_01",
          versionId: "ver_01",
          content: "Executed",
          provider: "deepseek",
          requestedModel: "deepseek-flash",
          resolvedModel: "deepseek-flash",
          productVersion: "DeepSeek-V4.1-Flash-1017",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          latencyMs: 500,
        }),
      ),
    );
    await expect(
      runLivePlayground({
        promptId: "prm_01",
        versionId: "ver_01",
        locale: "en",
        requestKey: "request-123",
      }),
    ).resolves.toMatchObject({ kind: "ready", data: { purpose: "PLAYGROUND" } });
  });
});

describe("optional database snapshot client", () => {
  it("stays disabled unless the browser opt-in flag is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED", "false");
    await expect(fetchRemoteSnapshot()).resolves.toEqual({ kind: "disabled" });
  });

  it("distinguishes unavailable API responses from valid snapshots", async () => {
    vi.stubEnv("NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(fetchRemoteSnapshot()).resolves.toEqual({ kind: "unavailable", code: "HTTP_503" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          prompts: [],
          versions: [],
          reports: [],
          history: [],
          libraryPromptIds: [],
          favorites: [],
          playgroundRuns: [],
          liveAdvice: [],
          profileName: "Demo",
        }),
      ),
    );
    await expect(fetchRemoteSnapshot()).resolves.toEqual({
      kind: "ready",
      snapshot: {
        prompts: [],
        versions: [],
        reports: [],
        history: [],
        libraryPromptIds: [],
        favorites: [],
        playgroundRuns: [],
        liveAdvice: [],
        profileName: "Demo",
      },
    });
  });
});
