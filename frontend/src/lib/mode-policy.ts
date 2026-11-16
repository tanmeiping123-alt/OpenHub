import type { Locale, Mode } from "./types";

// Approved product defaults, not an implementation of matching or permission grants.
export const MODE_POLICIES = Object.freeze({
  simple: Object.freeze({ defaultMatchingMode: "AUTO", skillCountPolicy: "TASK_DRIVEN" }),
  professional: Object.freeze({ defaultMatchingMode: "HYBRID", skillCountPolicy: "TASK_DRIVEN" }),
} as const);

export function describeModePolicy(mode: Mode, locale: Locale): string {
  const matchingMode = MODE_POLICIES[mode].defaultMatchingMode;
  if (locale === "zh-CN") {
    return `${mode === "simple" ? "简易" : "专家"}模式默认 ${matchingMode}。两种模式共用确定性任务分析和匹配，按任务需要使用零个、一个或多个 Skills，与 Free / Pro 无关；可查看并手动调整。切换模式保留既有计划，不调用模型、不产生费用；不会授权导入、脚本或工具。`;
  }
  return `${mode === "simple" ? "Simple" : "Professional"} defaults to ${matchingMode}. Both modes share deterministic analysis and matching, using zero, one, or multiple Skills by task need, independently of Free / Pro; selections can be inspected and adjusted. Switching modes preserves the plan, calls no model, incurs no fees, and grants no import, script or tool permissions.`;
}
