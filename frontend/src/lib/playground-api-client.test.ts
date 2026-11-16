import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "./api-client";
afterEach(() => vi.unstubAllGlobals());
describe("Playground saved request client", () => {
  it("exports a recovery read independent of runLivePlayground", () => {
    expect("fetchPlaygroundRequest" in client).toBe(true);
  });
  it.each([
    { status: "NOT_FOUND" },
    { status: "PENDING", executionId: "mex_1" },
    { status: "FAILED", executionId: "mex_1", errorCode: "MODEL_TIMEOUT" },
  ])("parses $status status with a read-only fetch", async (data) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(data));
    vi.stubGlobal("fetch", fetcher);
    expect(await client.fetchPlaygroundRequest("request-key")).toEqual({ kind: "ready", data });
    expect(fetcher).toHaveBeenCalledWith("/api/ai/playground?requestKey=request-key", {
      cache: "no-store",
    });
  });
  it.each([
    null,
    { status: "PENDING" },
    { status: "SUCCEEDED", executionId: "mex_1" },
    { status: "FAILED", executionId: 123 },
    { status: "UNKNOWN" },
  ])("rejects incomplete receipt %j", async (data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    expect(await client.fetchPlaygroundRequest("request-key")).toMatchObject({
      kind: "unavailable",
      code: "INVALID_PLAYGROUND_STATUS",
    });
  });
  it("retains authentication and transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "AUTH_REQUIRED" }, { status: 401 })),
    );
    expect(await client.fetchPlaygroundRequest("request-key")).toMatchObject({
      kind: "unavailable",
      code: "AUTH_REQUIRED",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await client.fetchPlaygroundRequest("request-key")).toMatchObject({
      kind: "unavailable",
      code: "NETWORK_ERROR",
    });
  });
  it("preserves the original succeeded output, session, usage, timing, and truncation evidence", async () => {
    const result = {
      executionMode: "LIVE",
      purpose: "PLAYGROUND",
      executionId: "mex_1",
      promptId: "p",
      versionId: "v",
      content: "Original partial answer",
      provider: "siliconflow",
      requestedModel: "model",
      resolvedModel: "model",
      productVersion: "model-v1",
      sessionId: "session_1",
      finishReason: "length",
      latencyMs: 1200,
      createdAt: "2026-11-10T00:00:00Z",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 15 },
    };
    const data = { status: "SUCCEEDED", executionId: "mex_1", result };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    expect(await client.fetchPlaygroundRequest("request-key")).toEqual({ kind: "ready", data });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...data, executionId: "other-execution" })),
    );
    expect(await client.fetchPlaygroundRequest("request-key")).toMatchObject({
      kind: "unavailable",
      code: "INVALID_PLAYGROUND_STATUS",
    });
  });
});
