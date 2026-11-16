import { beforeEach, describe, expect, it, vi } from "vitest";
const { generate, lookup } = vi.hoisted(() => ({ generate: vi.fn(), lookup: vi.fn() }));
vi.mock("@/lib/server/authenticated-route", () => ({ withIdentity: (fn: unknown) => fn }));
vi.mock("@/lib/server/api", () => ({
  guardLocalDemoApi: () => null,
  isRecord: (v: unknown) => !!v && typeof v === "object",
  boundedText: (v: unknown, n: number) => typeof v === "string" && v.length > 0 && v.length <= n,
}));
vi.mock("@/lib/server/model/model-service", () => ({ generateLiveSourceModel: generate }));
vi.mock("@/lib/server/model/model-repository", () => ({ getPlaygroundRequestStatus: lookup }));
import * as route from "./route";
const body = {
  promptId: "prompt",
  versionId: "version",
  locale: "en",
  requestKey: "request-key-123",
};
const post = (value: unknown) =>
  route.POST(
    new Request("http://localhost/api/ai/playground", {
      method: "POST",
      body: JSON.stringify(value),
      headers: { "Content-Type": "application/json" },
    }),
  );
describe("Playground recovery HTTP contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generate.mockResolvedValue({ executionMode: "LIVE" });
  });
  it.each([undefined, "short", "invalid space key", "x".repeat(101)])(
    "requires a safe request key: %s",
    async (requestKey) => {
      expect((await post({ ...body, requestKey })).status).toBe(400);
      expect(generate).not.toHaveBeenCalled();
    },
  );
  it("binds a valid key to the Playground request", async () => {
    expect((await post(body)).status).toBe(201);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ playgroundRequestKey: body.requestKey, purpose: "PLAYGROUND" }),
    );
  });
  it("exports a read-only GET recovery endpoint", () => {
    expect("GET" in route).toBe(true);
  });
  it.each([
    { status: "NOT_FOUND" },
    { status: "PENDING", executionId: "mex_1" },
    { status: "FAILED", executionId: "mex_1", errorCode: "MODEL_TIMEOUT" },
    { status: "SUCCEEDED", executionId: "mex_1", result: { executionMode: "LIVE" } },
  ])("reads $status without dispatching", async (data) => {
    lookup.mockResolvedValueOnce(data);
    const response = await route.GET(
      new Request("http://localhost/api/ai/playground?requestKey=request-key-123"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(data);
    expect(lookup).toHaveBeenCalledWith("request-key-123");
    expect(generate).not.toHaveBeenCalled();
  });
  it.each(["", "?requestKey=short", "?requestKey=has%20space%20key"])(
    "rejects unsafe recovery lookup %s",
    async (query) => {
      expect(
        (await route.GET(new Request(`http://localhost/api/ai/playground${query}`))).status,
      ).toBe(400);
      expect(lookup).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    },
  );
});
