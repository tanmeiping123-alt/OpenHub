// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResultActions } from "./ResultActions";

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("result actions", () => {
  it("keeps secondary actions together behind More", () => {
    render(<ResultActions locale="en" title="title" content="Body" />);
    expect(screen.getByRole("button", { name: "Copy body" })).toBeTruthy();
    const disclosure = screen.getByText("More").closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText("More"));
    expect(disclosure.open).toBe(true);
    expect(screen.getByRole("button", { name: "Copy Markdown" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Markdown (.md)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plain text (.txt)" })).toBeTruthy();
    expect(disclosure.querySelector("details")).toBeNull();
  });
  it("copies plain body and verbatim Markdown separately", async () => {
    render(<ResultActions locale="zh-CN" title="标题" content={"# 标题\n**正文**"} />);
    fireEvent.click(screen.getByText("复制正文"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制正文。"));
    expect(writeText).toHaveBeenLastCalledWith("标题\n正文");
    fireEvent.click(screen.getByText("更多"));
    fireEvent.click(screen.getByText("复制 Markdown"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已复制 Markdown。"));
    expect(writeText).toHaveBeenLastCalledWith("# 标题\n**正文**");
  });
  it("does not claim success when clipboard permission is denied", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<ResultActions locale="en" title="title" content="Body" />);
    fireEvent.click(screen.getByText("Copy body"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Copy failed"));
  });
  it("does not leave a stale copied message when the result changes", async () => {
    const view = render(<ResultActions locale="en" title="title" content="First" />);
    fireEvent.click(screen.getByText("Copy body"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Body copied."));
    view.rerender(<ResultActions locale="en" title="title" content="Second" />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
  it("disables copy for empty content", () => {
    render(<ResultActions locale="en" title="title" content="" />);
    expect(screen.getByRole("button", { name: "Copy body" }).hasAttribute("disabled")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
  it("reports a failed download instead of a success", () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => {
        throw new Error("blocked");
      },
    });
    render(<ResultActions locale="en" title="title" content="Body" />);
    fireEvent.click(screen.getByText("More"));
    fireEvent.click(screen.getByText("Markdown (.md)"));
    expect(screen.getByRole("status").textContent).toContain("Export failed");
  });
});
