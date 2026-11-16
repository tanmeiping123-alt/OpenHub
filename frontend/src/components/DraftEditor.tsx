"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import type { Locale } from "@/lib/types";
import { descriptorForPrompt, suggestPromptDescriptor } from "@/lib/prompt-description";
import { PromptDescriptorFields } from "./PromptDescriptorFields";

export function DraftEditor({ locale }: { locale: Locale }) {
  const { state, dispatch } = useAppStore();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(!!state.draft.savedCreation);
  const titleInput = useRef<HTMLInputElement>(null);
  const focusNewDraft = useRef(false);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  const pending = state.draft.creationRequest;
  const descriptor = pending
    ? descriptorForPrompt(pending)
    : (state.draft.descriptor ?? suggestPromptDescriptor(state.draft.content, locale));
  useEffect(() => {
    if (
      focusNewDraft.current &&
      !busy &&
      !saved &&
      !state.draft.savedCreation &&
      !state.draft.creationRequest
    ) {
      focusNewDraft.current = false;
      titleInput.current?.focus();
    }
  }, [busy, saved, state.draft.savedCreation, state.draft.creationRequest]);
  return (
    <section className="panel panel-pad stack" aria-label={t("New prompt draft", "新提示词草稿")}>
      <h1>{t("Prompt Editor", "Prompt 编辑器")}</h1>
      <p>
        {t(
          "Create a new Prompt from this draft. Existing Prompts stay unchanged.",
          "从草稿创建新的 Prompt，已有 Prompt 不会被覆盖。",
        )}
      </p>
      <label htmlFor="draft-title">{t("Prompt title", "Prompt 标题")}</label>
      <input
        ref={titleInput}
        id="draft-title"
        className="input"
        value={state.draft.title}
        maxLength={240}
        disabled={busy || saved || !!state.draft.creationRequest}
        onChange={(e) => void dispatch({ type: "SET_DRAFT", patch: { title: e.target.value } })}
      />
      <label htmlFor="draft-content">{t("Prompt content", "Prompt 内容")}</label>
      <textarea
        id="draft-content"
        className="textarea editor"
        value={state.draft.content}
        disabled={busy || saved || !!state.draft.creationRequest}
        onChange={(e) => void dispatch({ type: "SET_DRAFT", patch: { content: e.target.value } })}
      />
      <button
        className="btn btn-primary"
        disabled={
          busy ||
          saved ||
          !!state.draft.savedCreation ||
          !state.draft.title.trim() ||
          !state.draft.content.trim()
        }
        onClick={async () => {
          setBusy(true);
          try {
            const result = await dispatch({
              type: "CREATE_MANUAL_PROMPT",
              title: state.draft.title,
              taskType: state.draft.taskType,
              descriptor: pending ? pending.descriptor : descriptor,
              content: state.draft.content,
            });
            setSaved(result !== "unavailable");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? t("Saving…", "正在保存……")
          : state.draft.creationRequest
            ? t("Reconcile this save", "核对此次保存")
            : t("Save as new Prompt", "保存为新 Prompt")}
      </button>
      <details>
        <summary>{t("Purposes and tags · optional", "用途与标签 · 可选")}</summary>
        <div className="stack">
          <PromptDescriptorFields
            locale={locale}
            value={descriptor}
            disabled={busy || saved || !!state.draft.creationRequest}
            onChange={(next) => void dispatch({ type: "SET_DRAFT", patch: { descriptor: next } })}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || saved || !!state.draft.creationRequest}
            onClick={() =>
              void dispatch({
                type: "SET_DRAFT",
                patch: { descriptor: suggestPromptDescriptor(state.draft.content, locale) },
              })
            }
          >
            {t("Suggest from content", "根据正文重新建议")}
          </button>
        </div>
      </details>
      {(saved || state.draft.savedCreation) && state.draft.promptId && (
        <div className="row">
          <Link className="btn" href={`/${locale}/app/prompts/${state.draft.promptId}/edit`}>
            {t("Open saved Prompt", "打开已保存的 Prompt")}
          </Link>
          <button
            type="button"
            className="btn"
            disabled={busy || !!state.draft.creationRequest}
            onClick={async () => {
              if (busy || state.draft.creationRequest) return;
              focusNewDraft.current = true;
              const result = await dispatch({
                type: "SET_DRAFT",
                patch: {
                  title: "",
                  content: "",
                  taskType: "Writing",
                  promptId: null,
                  parentVersionId: undefined,
                  savedCreation: undefined,
                  creationRequest: undefined,
                  adoptedUseEventIds: undefined,
                  descriptor: undefined,
                },
              });
              if (result === "unavailable") {
                focusNewDraft.current = false;
                return;
              }
              setSaved(false);
            }}
          >
            {t("Write another Prompt", "再写一条 Prompt")}
          </button>
        </div>
      )}
      {state.draft.creationRequest && (
        <p role="status">
          {t(
            "The save result is unknown. Retry uses the same request; your draft is preserved.",
            "保存结果待核对。重试将使用同一请求，草稿已保留。",
          )}
        </p>
      )}
      <details>
        <summary>{t("Draft safety", "草稿安全说明")}</summary>
        <p className="small subtle">
          {t(
            "Saving does not call a model. Unsaved text stays in this account's browser session, and Skill text is never executed automatically.",
            "保存不会调用模型。未保存文本仅保留于此账号的浏览器会话，Skill 文本不会被自动执行。",
          )}
        </p>
      </details>
    </section>
  );
}
