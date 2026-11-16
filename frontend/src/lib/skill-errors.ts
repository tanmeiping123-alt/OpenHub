import type { Locale } from "./types";
import { modelTimeoutMessage } from "./model-error-messages";
const messages: Record<string, [string, string]> = {
  AUTH_REQUIRED: [
    "Please sign in again, then reconcile the same request.",
    "请重新登录，再核对同一次请求。",
  ],
  PERSONAL_RISK_ACCEPTANCE_REQUIRED: [
    "Acknowledge the risks for this exact source before importing.",
    "请先确认本次来源的个人使用风险。",
  ],
  PREPARED_SOURCE_EXPIRED_OR_NOT_FOUND: [
    "The preview expired and no matching import was found. Identify the source again.",
    "预览已过期，未发现对应导入记录，请重新识别来源。",
  ],
  GITHUB_LICENSE_MISSING: [
    "A UTF-8 root LICENSE file is required. Check the repository or use the offline route with your own rights confirmation.",
    "仓库根目录需有 UTF-8 LICENSE 文件；请核对来源，或在确认权利后使用离线上传。",
  ],
  INVALID_GITHUB_URL: [
    "Use an HTTPS github.com repository or tree link, without query parameters. Advanced fields support a fixed commit.",
    "请使用无查询参数的 HTTPS github.com 仓库或目录链接；也可用高级字段指定固定 commit。",
  ],
  GITHUB_FETCH_FAILED: [
    "GitHub could not be reached. Retry the same request; do not create another import while its result is unknown.",
    "暂时无法访问 GitHub，请核对同一次请求；结果未知时不要重复发起新的导入。",
  ],
  SKILL_NOT_AVAILABLE: [
    "This version is no longer available. Review the plan; locked versions will not be silently replaced.",
    "此版本已不可用，请检查计划；系统不会自动替换已锁定版本。",
  ],
  SKILL_NOT_FOUND: [
    "This Skill is unavailable or outside your access. Refresh the list.",
    "此 Skill 不可用或无访问权限，请刷新列表。",
  ],
  IDEMPOTENCY_CONFLICT: [
    "This request key belongs to different content. Reconcile the original operation first.",
    "请求凭据已绑定其他内容，请先核对原操作。",
  ],
  SKILL_CONTEXT_TOO_LARGE: [
    "The selected context exceeds the 48 KiB safety bound. Select fewer or smaller Skills.",
    "选中上下文超过 48 KiB 安全上限，请减少 Skills 或缩小资料。",
  ],
  TOO_MANY_SKILLS: [
    "Select at most four Skills per bounded plan.",
    "单个有界计划最多选择 4 个 Skills。",
  ],
  VERSION_CONFLICT: [
    "The source version changed. Refresh and create a new proposal; your existing proposal is retained.",
    "源版本已变化，请刷新并重新生成提案，原提案仍保留。",
  ],
  INVALID_INPUT: [
    "Check the required fields and supported format, then retry.",
    "请检查必填字段与支持格式后重试。",
  ],
  BUNDLE_SIZE_LIMIT: [
    "Upload at most 1 MiB total, with each resource at most 128 KiB.",
    "上传总量最多 1 MiB，单个资源最多 128 KiB。",
  ],
};
export function skillErrorMessage(code: string, locale: Locale) {
  if (code === "MODEL_REQUEST_TIMEOUT") return modelTimeoutMessage(locale);
  const m = messages[code];
  return m
    ? m[locale === "zh-CN" ? 1 : 0]
    : locale === "zh-CN"
      ? "操作未完成。请检查来源及格式；结果未知时使用同一请求核对，勿重复创建。"
      : "The operation did not complete. Check the source and format; reconcile the same request when the outcome is unknown.";
}
