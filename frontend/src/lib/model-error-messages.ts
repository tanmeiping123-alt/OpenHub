import type { Locale } from "./types";

export function modelTimeoutMessage(locale: Locale) {
  return locale === "zh-CN"
    ? "模型等待超时，尚未取得完整结果。供应商可能仍在处理并产生费用，系统不会自动重试；请先在设置中查看待核对费用，再决定是否重新发起。"
    : "The model timed out before a complete result was received. The provider may still process or charge the request. No automatic retry will be made; check pending costs in Settings before sending another request.";
}

export function modelErrorDetail(error: { code: string; message: string }, locale: Locale) {
  if (locale === "zh-CN") {
    const reportMessages: Record<string, string> = {
      MODEL_EVALUATION_INVALID_REPORT:
        "供应商报告截断、格式不符合要求或原文引用无效，未发布为有效评估报告。原始输出和已知用量已保留，不会自动重试；请先核对用量。",
      MODEL_EVALUATION_PENDING:
        "这份评估请求仍在处理中，恢复操作未重复调用供应商。请稍后刷新已保存报告，并核对待处理费用。",
      MODEL_EVALUATION_PREVIOUSLY_FAILED:
        "这份评估请求此前失败，未重复调用供应商。请先核对费用，再决定是否明确新建评估请求。",
      MODEL_EVALUATION_REQUEST_CONFLICT:
        "当前请求属于其他版本或设置。请先确认已保存版本，再明确新建评估请求。",
    };
    if (reportMessages[error.code]) return `${error.code}: ${reportMessages[error.code]}`;
  }
  return `${error.code}: ${error.code === "MODEL_REQUEST_TIMEOUT" ? modelTimeoutMessage(locale) : error.message}`;
}
