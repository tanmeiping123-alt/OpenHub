import { describe, expect, it } from "vitest";
import { fillPromptVariables, promptVariables } from "./prompt-variables";

describe("explicit Prompt variables", () => {
  it("collects unique declared placeholders in first appearance order", () => {
    expect(promptVariables("解释 {{概念}} 给 {{audience_name}}。再次 {{概念}}。")).toEqual([
      "概念",
      "audience_name",
    ]);
  });
  it("ignores ordinary JSON, code blocks, expressions and ambiguous nested braces", () => {
    expect(
      promptVariables(
        '{"name":"topic","nested":{"value":1}}\n```js\n{{ code }}\n```\n`{{ inline }}`\n{{user.name}} {{x + y}} {{{nested}}} {{"key":1}}',
      ),
    ).toEqual([]);
  });
  it("replaces original tokens once with literal values and leaves empty or undeclared values alone", () => {
    const original = "{{topic}} / {{topic}} / {{reader}}";
    expect(
      fillPromptVariables(original, { topic: "$& {{reader}}", reader: "", unknown: "secret" }),
    ).toBe("$& {{reader}} / $& {{reader}} / {{reader}}");
    expect(original).toBe("{{topic}} / {{topic}} / {{reader}}");
  });
  it("does not interpret placeholders inside code spans with multiple backticks", () => {
    expect(promptVariables("Use ``{{example}}`` and fill {{topic}}.")).toEqual(["topic"]);
    expect(
      fillPromptVariables("Use ``{{example}}`` and fill {{topic}}.", {
        example: "changed",
        topic: "space",
      }),
    ).toBe("Use ``{{example}}`` and fill space.");
  });
});
