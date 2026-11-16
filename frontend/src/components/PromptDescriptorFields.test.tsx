// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PromptDescriptorFields } from "./PromptDescriptorFields";
import type { PromptDescriptor } from "@/lib/prompt-description";

function Form() {
  const [value, setValue] = useState<PromptDescriptor>({ purposes: ["create"], tags: ["汇报"] });
  return (
    <>
      <PromptDescriptorFields locale="zh-CN" value={value} onChange={setValue} />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}
describe("optional description editing", () => {
  it("supports several purposes, removing every suggestion and a new tag", () => {
    render(<Form />);
    fireEvent.click(screen.getByLabelText("分析与研究"));
    expect(screen.getByRole("status").textContent).toContain('"create","analyze"');
    fireEvent.click(screen.getByRole("button", { name: "移除标签：汇报" }));
    fireEvent.change(screen.getByLabelText("添加标签"), { target: { value: "经营" } });
    fireEvent.keyDown(screen.getByLabelText("添加标签"), { key: "Enter" });
    expect(screen.getByRole("status").textContent).toContain('"tags":["经营"]');
    fireEvent.click(screen.getByRole("button", { name: "清空用途和标签" }));
    expect(screen.getByRole("status").textContent).toBe('{"purposes":[],"tags":[]}');
  });
});
