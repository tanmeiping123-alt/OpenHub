import { describe, expect, it } from "vitest";
import { modelErrorDetail, modelTimeoutMessage } from "./model-error-messages";
import { skillErrorMessage } from "./skill-errors";

describe("live timeout feedback", () => {
  it.each(["zh-CN", "en"] as const)("reuses safe timeout feedback in all %s flows", (locale) => {
    const code = "MODEL_REQUEST_TIMEOUT";
    const message = modelTimeoutMessage(locale);
    expect(modelErrorDetail({ code, message: "Old generic timeout" }, locale)).toBe(
      `${code}: ${message}`,
    );
    expect(skillErrorMessage(code, locale)).toBe(message);
    expect(message).not.toContain("Old generic timeout");
  });
  it("explains unknown costs and avoids encouraging an immediate duplicate request", () => {
    expect(modelTimeoutMessage("zh-CN")).toContain("系统不会自动重试");
    expect(modelTimeoutMessage("zh-CN")).toContain("供应商可能仍在处理并产生费用");
    expect(modelTimeoutMessage("en")).toContain("No automatic retry");
  });
  it("preserves non-timeout details", () => {
    expect(
      modelErrorDetail({ code: "SILICONFLOW_RATE_LIMITED", message: "Rate limited" }, "zh-CN"),
    ).toBe("SILICONFLOW_RATE_LIMITED: Rate limited");
  });
});
