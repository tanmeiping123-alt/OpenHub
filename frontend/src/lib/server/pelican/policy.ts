import "server-only";
import { createHash } from "node:crypto";
import { PELICAN_PROMPT, type PelicanCreateInput } from "@/lib/pelican-types";
import { modelSelection, validModelSelection } from "@/lib/model-catalog";
import type { LiveModelConfig, ModelMessage } from "../model/model-types";
import { AccountError } from "../account-errors";
import { currentActor } from "../identity-context";
import { modelRequestOptions } from "../model/model-request-options";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}
export const pelicanHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
export const requirePelicanAdmin = () => {
  const actor = currentActor();
  if (!actor) throw new AccountError("AUTH_REQUIRED", 401);
  if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
  return actor;
};
// Uniform platform instruction for every model. The user-facing challenge text stays
// exactly PELICAN_PROMPT; this only constrains delivery so the sandboxed preview can
// safely render the work and the comparison stays like-for-like across providers.
const PELICAN_DELIVERY_INSTRUCTION =
  "你是网页动画作品生成器。只返回一份可直接在浏览器打开的完整 HTML 文档（或以 <svg> 开头的完整 SVG 文档），从文档开始到结束不写任何 Markdown 代码围栏，也不写前后说明、标题、目录或解释。所有样式、脚本和图形全部内联；禁止引用任何外部资源（不加载字体、图片、脚本或样式表），禁止使用音频、网络、存储或文档时间线等浏览器能力。动画用内联 CSS、SVG SMIL 或内联 JavaScript 实现。代码保持简洁、能一次完整输出，避免因超长被截断。";
export const pelicanMessages = (): readonly ModelMessage[] => [
  { role: "system", content: PELICAN_DELIVERY_INSTRUCTION },
  { role: "user", content: PELICAN_PROMPT },
];
// Must match the shared vendor adapter. The fetch boundary verifies equality before sending.
export function pelicanPayload(config: LiveModelConfig) {
  return {
    model: config.model,
    messages: pelicanMessages(),
    ...modelRequestOptions(config),
    temperature: 0.2,
    stream: false,
  };
}
export function parsePelicanCreate(value: unknown): PelicanCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountError("INVALID_INPUT");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["requestKey", "title", "selections"].includes(k)) ||
    typeof v.requestKey !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(v.requestKey) ||
    typeof v.title !== "string" ||
    !v.title.trim() ||
    v.title.length > 100 ||
    /[\u0000-\u001f<>]/.test(v.title) ||
    !Array.isArray(v.selections) ||
    v.selections.length < 1 ||
    v.selections.length > 5
  )
    throw new AccountError("INVALID_INPUT");
  const seen = new Set<string>();
  const selections = v.selections.map((s) => {
    if (
      !s ||
      typeof s !== "object" ||
      Array.isArray(s) ||
      Object.keys(s).some((k) => !["modelKey", "strength", "maxOutputTokens"].includes(k)) ||
      !validModelSelection(s)
    )
      throw new AccountError("INVALID_INPUT");
    const selected = modelSelection(s);
    const key = selected.modelKey ?? "deepseek-direct";
    if (seen.has(key)) throw new AccountError("DUPLICATE_MODEL");
    seen.add(key);
    return selected;
  });
  return { requestKey: v.requestKey, title: v.title.trim(), selections };
}
