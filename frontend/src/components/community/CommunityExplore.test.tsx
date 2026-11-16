// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityExplore } from "./CommunityExplore";

const state = vi.hoisted(() => ({ params: "", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push }),
  useSearchParams: () => new URLSearchParams(state.params),
}));
vi.mock("./CommunityShell", () => ({ useCommunity: () => ({ locale: "en", viewer: null }) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.push.mockClear();
  state.params = "";
});

function listing() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        items: [],
        total: 0,
        page: 1,
        pageSize: 12,
      }),
    ),
  );
}
it("defaults keyword discovery to relevance and exposes six purposes", async () => {
  state.params = "q=explain&language=en&page=3";
  const fetcher = listing();
  render(<CommunityExplore />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(String(fetcher.mock.calls[0][0])).toContain("sort=relevance");
  expect(screen.getByRole("button", { name: "Most relevant" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Understand & transform" }));
  const next = new URL(state.push.mock.calls[0][0], "https://example.test");
  expect(next.searchParams.get("purpose")).toBe("understand");
  expect(next.searchParams.get("q")).toBe("explain");
  expect(next.searchParams.get("language")).toBe("en");
  expect(next.searchParams.has("page")).toBe(false);
});
it("keeps an explicit ranking and other filters when applying a tag", async () => {
  state.params = "q=explain&sort=recent&purpose=understand&language=en&page=3";
  listing();
  render(<CommunityExplore />);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter by tag" }), {
    target: { value: " learning " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply tag" }));
  const next = new URL(state.push.mock.calls[0][0], "https://example.test");
  expect(next.searchParams.get("tag")).toBe("learning");
  expect(next.searchParams.get("sort")).toBe("recent");
  expect(next.searchParams.get("purpose")).toBe("understand");
});
it("reflects restored URL filters after browser navigation", async () => {
  listing();
  const { rerender } = render(<CommunityExplore />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search Prompts" }), {
    target: { value: "unsent" },
  });
  state.params = "q=restored&tag=resume&purpose=improve";
  rerender(<CommunityExplore />);
  expect((screen.getByRole("textbox", { name: "Search Prompts" }) as HTMLInputElement).value).toBe(
    "restored",
  );
  expect((screen.getByRole("textbox", { name: "Filter by tag" }) as HTMLInputElement).value).toBe(
    "resume",
  );
});
it("returns to the Star ranking when an old relevance URL has no keyword", async () => {
  state.params = "sort=relevance";
  const fetcher = listing();
  render(<CommunityExplore />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(String(fetcher.mock.calls[0][0])).toContain("sort=stars");
  expect(screen.getByRole("button", { name: "Most starred" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});
