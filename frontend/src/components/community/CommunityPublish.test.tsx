// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityPublish } from "./CommunityPublish";
const state = vi.hoisted(() => ({ params: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.params),
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock("./CommunityShell", () => ({
  useCommunity: () => ({
    locale: "en",
    viewer: { user: { id: "author", name: "Author", bio: "" } },
    reloadViewer: vi.fn(),
  }),
}));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  state.params = "";
});

it("publishes optional multiple purposes and normalized tags only after an accurate preview", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ publicId: "published", versionNumber: 1 })));
  render(<CommunityPublish />);
  expect(screen.queryByRole("combobox", { name: "Category" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Explain a design" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "What does it help with?" }), {
    target: { value: "Explain and build" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Complete Prompt" }), {
    target: { value: "Explain {{topic}} and make a plan." },
  });
  fireEvent.click(screen.getByText("Make it easier to use"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Understand & transform" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Plan & decide" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), {
    target: { value: "Design, design,  学习" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview publication" }));
  expect(screen.getByText("Understand & transform")).toBeTruthy();
  expect(screen.getByText("Plan & decide")).toBeTruthy();
  expect(screen.getByText(/#Design/).textContent).toBe("#Design · #学习");
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm publication" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  const payload = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(payload.purposes).toEqual(["understand", "plan"]);
  expect(payload.tags).toEqual(["Design", "学习"]);
  expect(payload.content).toBe("Explain {{topic}} and make a plan.");
});
it("uses the selected private source descriptor and allows clearing it", async () => {
  state.params = "sourceVersionId=source";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        title: "Saved source",
        content: "exact saved body",
        taskType: "General",
        sourceVersionId: "source",
        origin: null,
        descriptor: { purposes: ["build"], tags: ["api"] },
      }),
    ),
  );
  render(<CommunityPublish />);
  const checked = await screen.findByRole("checkbox", { name: "Develop & build" });
  expect((checked as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear purposes and tags" }));
  expect((checked as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("textbox", { name: "Tags" }) as HTMLInputElement).value).toBe("");
});
it("accepts all twelve valid shared descriptor tags at the forty-character boundary", () => {
  render(<CommunityPublish />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Boundary tags" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "What does it help with?" }), {
    target: { value: "Shared metadata" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Complete Prompt" }), {
    target: { value: "Preserve exact body." },
  });
  fireEvent.click(screen.getByText("Make it easier to use"));
  const tags = Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(40, "a"));
  fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), {
    target: { value: tags.join(",") },
  });
  const preview = screen.getByRole("button", { name: "Preview publication" });
  expect((preview as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(preview);
  expect(screen.getByRole("button", { name: "Confirm publication" })).toBeTruthy();
});
it("reconciles an uncertain publication with its original descriptor and request body", async () => {
  const payload = {
    title: "Retained",
    summary: "Retained summary",
    content: "exact body",
    taskType: "General",
    purposes: ["analyze", "plan"],
    tags: ["data"],
    language: "en",
    authorName: "Author",
    authorBio: "",
    variables: "",
    modelNotes: "",
    exampleInput: "",
    exampleOutput: "",
    usageNotes: "",
    changeNote: "",
    consent: true,
  };
  const body = JSON.stringify(payload);
  sessionStorage.setItem(
    "open-prompt-request:author:publish:new",
    JSON.stringify({ key: "original-key", body }),
  );
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ publicId: "published", versionNumber: 1 })));
  render(<CommunityPublish />);
  expect(
    (screen.getByRole("button", { name: "Back to editing" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reconcile publication" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(fetcher.mock.calls[0][1]?.body).toBe(body);
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "Idempotency-Key": "original-key" });
  await waitFor(() =>
    expect(sessionStorage.getItem("open-prompt-request:author:publish:new")).toBeNull(),
  );
});
