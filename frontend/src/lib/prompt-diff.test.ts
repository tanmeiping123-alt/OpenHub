import { describe, expect, it } from "vitest";
import { promptDiff } from "./prompt-diff";

describe("exact Prompt body comparison", () => {
  it("shows the exact removed and added requirements with unchanged context", () => {
    const before = "目标：汇报\n金额：500元\n写三段";
    const after = "目标：汇报\n金额：500元\n写一段";
    const diff = promptDiff(before, after);
    expect(
      diff
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      diff
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
    expect(diff.some((p) => p.kind === "removed" && p.text.includes("三"))).toBe(true);
    expect(diff.some((p) => p.kind === "added" && p.text.includes("一"))).toBe(true);
  });
  it("preserves spaces, blank lines, CRLF, code and hard values", () => {
    const before = '```json\r\n{ "amount": 500 }\r\n```\n\n';
    const after = before.replace("500", "600");
    const diff = promptDiff(before, after);
    expect(
      diff
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      diff
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
  });
  it("leaves identical text unchanged, including an empty Prompt", () => {
    expect(promptDiff("一句话", "一句话")).toEqual([{ kind: "same", text: "一句话" }]);
    expect(promptDiff("", "")).toEqual([]);
  });
  it("preserves standalone carriage returns and Unicode whitespace in changed text", () => {
    const before = "first\r500\u2028next\u2029last";
    const after = "first\r600\u2028next\u2029last";
    const diff = promptDiff(before, after);
    expect(
      diff
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      diff
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
  });
  it("handles maximum sized bodies without a quadratic matrix", () => {
    const before = "a\n".repeat(100000);
    const after = "b\n".repeat(100000);
    const diff = promptDiff(before, after);
    expect(diff.length).toBeLessThanOrEqual(3);
    expect(
      diff
        .filter((p) => p.kind !== "added")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      diff
        .filter((p) => p.kind !== "removed")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
  });
});
