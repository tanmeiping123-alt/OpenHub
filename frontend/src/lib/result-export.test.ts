import { describe, expect, it } from "vitest";
import { resultFilename, resultPlainText } from "./result-export";

describe("result exports", () => {
  it("keeps body and links but removes common Markdown presentation", () => {
    expect(
      resultPlainText(
        "# 中文计划\r\n\r\n- **软删除**\n> 检查 `deleted_at`\n[来源](https://example.test)",
      ),
    ).toBe("中文计划\n\n• 软删除\n检查 deleted_at\n来源 (https://example.test)");
  });
  it("preserves code, indentation, operators and Chinese text inside fences", () => {
    expect(resultPlainText("```sql\n  SELECT ** FROM x; -- 中文\n```\n结束")).toBe(
      "  SELECT ** FROM x; -- 中文\n结束",
    );
    expect(resultPlainText("~~~~ts\na * b\n~~~\n~~~~")).toBe("a * b\n~~~");
  });
  it("does not alter ordinary text, underscores or HTML-like source", () => {
    const text = "deleted_at >= 0\n<script>source only</script>\n中文正文";
    expect(resultPlainText(text)).toBe(text);
  });
  it("produces bounded Windows-safe names and keeps formats distinct", () => {
    expect(resultFilename("CON", "txt")).toBe("PromptMaster-CON.txt");
    expect(resultFilename(" ../a:b? ", "md")).toBe("PromptMaster-..-a-b-.md");
    expect(resultFilename(" ", "md")).toBe("PromptMaster-prompt-result.md");
    expect(resultFilename("长".repeat(200), "md").length).toBeLessThan(100);
  });
});
