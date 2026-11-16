import type { AppState, Locale } from "./types";
import { localizedContentFor, localizedTitleFor } from "./fixtures";

export function hasUnsavedDraft(state: AppState, locale: Locale) {
  const d = state.draft;
  if (d.creationRequest) return true;
  const v = state.versions.find((v) => v.id === d.parentVersionId && v.promptId === d.promptId);
  if (!v) return !!(d.content.trim() || d.title.trim() || d.descriptor);
  const p = state.prompts.find((p) => p.id === v.promptId);
  return (
    d.content !== localizedContentFor(v.id, locale, v.content) ||
    d.title !== localizedTitleFor(v.promptId, locale, v.title) ||
    d.taskType !== p?.taskType ||
    JSON.stringify(d.descriptor) !== JSON.stringify(p?.descriptor)
  );
}

export type PromptAction = "edit" | "evaluate" | "optimize" | "playground" | "share";
export function promptActionHref(
  locale: Locale,
  promptId: string,
  versionId: string,
  action: PromptAction,
) {
  const version = encodeURIComponent(versionId);
  if (action === "share") return `/${locale}/open-prompts/new?sourceVersionId=${version}`;
  if (action === "playground")
    return `/${locale}/app/playground?promptId=${encodeURIComponent(promptId)}&versionId=${version}`;
  return `/${locale}/app/prompts/${encodeURIComponent(promptId)}/${action}?versionId=${version}`;
}

export function resolvePromptContext(state: AppState, promptId?: string, versionId?: string) {
  const prompt = promptId
    ? state.prompts.find((p) => p.id === promptId)
    : (state.prompts.find((p) => p.id === state.draft.promptId) ?? state.prompts[0]);
  const target =
    versionId ??
    (state.draft.promptId === prompt?.id ? state.draft.parentVersionId : undefined) ??
    prompt?.currentVersionId;
  const version = state.versions.find((v) => v.id === target && v.promptId === prompt?.id);
  return { prompt, version };
}
