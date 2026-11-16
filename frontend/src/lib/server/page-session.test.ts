import { beforeEach, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("./accounts", async (original) => ({
  ...(await original<typeof import("./accounts")>()),
  sessionActor: vi.fn(),
}));
import { cookies } from "next/headers";
import { sessionActor, AccountError } from "./accounts";
import { pageSession } from "./page-session";
const jar = vi.hoisted(() => ({ getAll: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cookies).mockResolvedValue(jar as unknown as Awaited<ReturnType<typeof cookies>>);
});
it("does not query the database for missing cookies", async () => {
  jar.getAll.mockReturnValue([]);
  expect(await pageSession()).toEqual({ actor: null, reason: "required" });
  expect(sessionActor).not.toHaveBeenCalled();
});
it("validates the cookie value, rather than trusting cookie presence", async () => {
  jar.getAll.mockReturnValue([{ value: "invalid" }]);
  vi.mocked(sessionActor).mockRejectedValue(new AccountError("AUTH_REQUIRED", 401));
  expect(await pageSession()).toEqual({ actor: null, reason: "expired" });
  expect(vi.mocked(sessionActor).mock.calls[0][0].headers.get("cookie")).toBe("pm_session=invalid");
});
it("unavailable account service fails closed without leaking details", async () => {
  jar.getAll.mockReturnValue([{ value: "a".repeat(64) }]);
  vi.mocked(sessionActor).mockRejectedValue(new Error("PRIVATE_DATABASE_DETAIL"));
  expect(await pageSession()).toEqual({ actor: null, reason: "unavailable" });
});
it("returns only the server-verified account actor", async () => {
  const actor = { id: "test-owner", email: "fixture@example.test", role: "USER" as const };
  jar.getAll.mockReturnValue([{ value: "a".repeat(64) }]);
  vi.mocked(sessionActor).mockResolvedValue(actor);
  expect(await pageSession()).toEqual({ actor, reason: "" });
});
