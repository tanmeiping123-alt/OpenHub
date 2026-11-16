// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PromptBody } from "./PromptBody";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("copies the exact public body without fetching or adding attribution", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const fetcher = vi.spyOn(globalThis, "fetch");
  const body = "# 标题\n请处理 {{任务}}\n<script>alert(1)</script>";
  render(<PromptBody content={body} locale="zh-CN" />);
  fireEvent.click(screen.getByRole("button", { name: "复制原文" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("已复制");
});
it("offers selectable text when the clipboard is blocked and never reports success", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(<PromptBody content="source body" locale="en" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy original" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Select"));
  expect(screen.getByRole("textbox", { name: "Prompt content" }).textContent).toBe("source body");
});
it("starts prototype-named variables empty and fills their literal values", () => {
  render(
    <PromptBody content="{{constructor}} {{toString}} {{__proto__}}" locale="en" fillVariables />,
  );
  fireEvent.click(screen.getByText("Fill in variables"));
  for (const name of ["constructor", "toString", "__proto__"]) {
    const input = screen.getByRole("textbox", { name }) as HTMLTextAreaElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: name } });
  }
  expect(screen.getByRole("textbox", { name: "Filled Prompt preview" }).textContent).toBe(
    "constructor toString __proto__",
  );
});
it("fills explicit variables locally while preserving exact original copying", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const fetcher = vi.spyOn(globalThis, "fetch");
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const original = 'Explain {{topic}} for {{reader}}. {"key":1}';
  const { unmount } = render(<PromptBody content={original} locale="en" fillVariables />);
  fireEvent.click(screen.getByText("Fill in variables"));
  fireEvent.change(screen.getByRole("textbox", { name: "topic" }), {
    target: { value: "$& {{reader}}" },
  });
  expect(screen.getByRole("textbox", { name: "Filled Prompt preview" }).textContent).toBe(
    'Explain $& {{reader}} for {{reader}}. {"key":1}',
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy filled Prompt" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith('Explain $& {{reader}} for {{reader}}. {"key":1}'),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy original" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(original));
  expect(fetcher).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
  expect(window.location.search).toBe("");
  unmount();
  render(<PromptBody content={original} locale="en" fillVariables />);
  fireEvent.click(screen.getByText("Fill in variables"));
  expect((screen.getByRole("textbox", { name: "topic" }) as HTMLInputElement).value).toBe("");
});
