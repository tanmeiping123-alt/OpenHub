import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/server/accounts", () => ({
  sessionActor: state.session,
  AccountError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, status = 400) {
      super(code);
      this.code = code;
      this.status = status;
    }
  },
}));
vi.mock("@/lib/server/db", () => ({
  withTransaction: async (work: (c: unknown) => unknown) => work({}),
}));
vi.mock("@/lib/server/community/service", () => ({ list: state.list, detail: state.detail }));
import { GET } from "./route";
import { GET as detailGET } from "./[id]/route";
describe("anonymous community transport", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PROMPTMASTER_DEMO_API_ENABLED", "true");
    vi.clearAllMocks();
    state.list.mockResolvedValue({ items: [], total: 0 });
    state.detail.mockResolvedValue({ id: "public" });
  });
  it("does not resolve identity even with a stale or malformed cookie", async () => {
    const r = await GET(
      new Request("http://localhost:3000/api/community", {
        headers: { host: "localhost:3000", cookie: "pm_session=malformed" },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(state.session).not.toHaveBeenCalled();
  });
  it("transports combined purpose and tag discovery filters anonymously", async () => {
    const response = await GET(
      new Request(
        "http://localhost:3000/api/community?q=resume&purpose=improve&tag=career&sort=relevance",
        { headers: { host: "localhost:3000" } },
      ),
    );
    expect(response.status).toBe(200);
    const params = state.list.mock.calls[0][1] as URLSearchParams;
    expect(params.get("purpose")).toBe("improve");
    expect(params.get("tag")).toBe("career");
    expect(state.session).not.toHaveBeenCalled();
  });
  it("never authenticates public historical reads and keeps responses uncacheable", async () => {
    const r = await detailGET(
      new Request("http://localhost:3000/api/community/pub_x?version=1", {
        headers: { host: "localhost:3000" },
      }),
      { params: Promise.resolve({ id: "pub_x" }) },
    );
    expect(r.status).toBe(200);
    expect(state.detail).toHaveBeenCalledWith({}, "pub_x", 1);
    expect(state.session).not.toHaveBeenCalled();
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
  it("retains loopback transport and rejects unexpected query keys", async () => {
    expect(
      (await GET(new Request("http://evil.test/api/community", { headers: { host: "evil.test" } })))
        .status,
    ).toBe(404);
    expect(
      (
        await GET(
          new Request("http://localhost/api/community?ownerId=secret", {
            headers: { host: "localhost" },
          }),
        )
      ).status,
    ).toBe(400);
  });
});
