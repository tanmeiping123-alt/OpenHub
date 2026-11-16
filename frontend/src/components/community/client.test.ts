// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { communityFetch, communityMutation } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it("retains the request deadline when a caller supplies cancellation", async () => {
  const deadline = new AbortController();
  const caller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let received: AbortSignal | null | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    received = init?.signal;
    return new Response("{}", { status: 200 });
  });
  await communityFetch("/api/community", { signal: caller.signal });
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  expect(received?.aborted).toBe(true);
  expect(caller.signal.aborted).toBe(false);
});

it("retains the same idempotency key after an uncertain response and rejects changed payloads", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("Network error"))
    .mockResolvedValueOnce(new Response('{"publicId":"pub_test"}', { status: 200 }));
  const payload = { content: "exact text" };
  await expect(
    communityMutation("actor", "publish", "/api/community", "POST", payload),
  ).rejects.toThrow("UNCONFIRMED");
  await expect(
    communityMutation("actor", "publish", "/api/community", "POST", { content: "changed" }),
  ).rejects.toThrow("PENDING_REQUEST");
  await expect(
    communityMutation("actor", "publish", "/api/community", "POST", payload),
  ).resolves.toEqual({ publicId: "pub_test" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1]?.headers).toEqual(fetcher.mock.calls[1][1]?.headers);
  expect(sessionStorage.length).toBe(0);
});
