// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityModeration } from "./CommunityModeration";

vi.mock("./CommunityShell", () => ({
  useCommunity: () => ({
    locale: "zh-CN",
    viewer: { user: { id: "creator_admin", role: "ADMIN" } },
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
const data = {
  reports: [],
  stars: [],
  events: [],
  paging: {
    reports: { page: 1, total: 101, pageSize: 100 },
    stars: { page: 1, total: 0, pageSize: 100 },
    events: { page: 1, total: 0, pageSize: 100 },
  },
};

it("restores an uncertain moderation decision after remount and reconciles the exact request", async () => {
  const payload = {
    action: "remove",
    publicId: "pub_test",
    reason: "原始事实依据，必须原样核对。",
  };
  sessionStorage.setItem(
    "open-prompt-request:creator_admin:moderate",
    JSON.stringify({ key: "original-key", body: JSON.stringify(payload) }),
  );
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (_url, init) =>
        new Response(JSON.stringify(init?.method === "POST" ? { ok: true } : data)),
    );
  render(<CommunityModeration />);
  const input = await screen.findByRole("textbox", { name: "处理原因" });
  expect((input as HTMLTextAreaElement).value).toBe(payload.reason);
  expect((input as HTMLTextAreaElement).readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "核对此次处理" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("处理决定已记录"));
  const call = fetcher.mock.calls.find(([, init]) => init?.method === "POST");
  expect(call?.[1]?.body).toBe(JSON.stringify(payload));
  expect(call?.[1]?.headers).toMatchObject({ "Idempotency-Key": "original-key" });
  expect(sessionStorage.length).toBe(0);
});

it("requests later moderation pages", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(data)));
  render(<CommunityModeration />);
  fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("reportsPage=2"))).toBe(true),
  );
});
