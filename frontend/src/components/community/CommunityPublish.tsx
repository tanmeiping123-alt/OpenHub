"use client";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, Globe2, Send, X } from "lucide-react";
import type {
  CommunityDetail,
  CommunityOrigin,
  CommunitySeed,
  PublicationInput,
} from "@/lib/community-types";
import type { Locale } from "@/lib/types";
import {
  legacyPurposes,
  normalizeTags,
  purposes,
  suggestPromptDescriptor,
  type PromptDescriptor,
} from "@/lib/prompt-description";
import {
  communityFetch,
  communityMutation,
  errorText,
  readReceipt,
  text,
  useCommunityResource,
} from "./client";
import { useCommunity } from "./CommunityShell";
import { CommunityFailure, CommunityLoading, PurposeLabels } from "./Common";
import { PromptBody } from "./PromptBody";

const blank: PublicationInput = {
  title: "",
  summary: "",
  content: "",
  taskType: "General",
  purposes: [],
  language: "zh-CN",
  tags: [],
  variables: "",
  modelNotes: "",
  exampleInput: "",
  exampleOutput: "",
  usageNotes: "",
  changeNote: "",
  authorName: "",
  authorBio: "",
  consent: false,
};
export function CommunityPublish({ id }: { id?: string }) {
  const search = useSearchParams();
  const { locale, viewer } = useCommunity();
  const sourceId = search.get("sourceVersionId");
  const url = id
    ? `/api/community/me?id=${encodeURIComponent(id)}`
    : sourceId
      ? `/api/community/source?versionId=${encodeURIComponent(sourceId)}`
      : null;
  const resource = useCommunityResource<CommunityDetail | CommunitySeed>(url);
  if (url && resource.loading) return <CommunityLoading locale={locale} />;
  if (resource.error)
    return <CommunityFailure locale={locale} error={resource.error} retry={resource.reload} />;
  if (!viewer?.user) return null;
  const detail = id ? (resource.data as CommunityDetail | null) : null;
  const seed = !id ? (resource.data as CommunitySeed | null) : null;
  if (detail?.status === "REMOVED")
    return (
      <section className="op-state">
        <h1>{text(locale, "This publication was removed", "此作品已被下架")}</h1>
        <p>
          {text(
            locale,
            "An administrator must review it before it can be published again.",
            "需管理员复核后才能恢复公开。",
          )}
        </p>
        <Link className="op-button" href={`/${locale}/open-prompts/me`}>
          {text(locale, "My publications", "返回我的发布")}
        </Link>
      </section>
    );
  const initial: PublicationInput = detail
    ? {
        ...blank,
        title: detail.title,
        summary: detail.summary,
        taskType: detail.taskType,
        purposes: detail.purposes ?? legacyPurposes(detail.taskType),
        language: detail.language,
        tags: detail.tags,
        content: detail.version.content,
        variables: detail.version.variables,
        modelNotes: detail.version.modelNotes,
        exampleInput: detail.version.exampleInput,
        exampleOutput: detail.version.exampleOutput,
        usageNotes: detail.version.usageNotes,
        authorName: detail.author.name,
        authorBio: detail.author.bio,
        baseVersion: detail.versionNumber,
      }
    : {
        ...blank,
        language: locale,
        authorName: viewer.user.name,
        authorBio: viewer.user.bio,
        ...(seed
          ? {
              title: seed.title,
              content: seed.content,
              taskType: seed.taskType,
              purposes: seed.descriptor?.purposes ?? legacyPurposes(seed.taskType),
              tags: seed.descriptor?.tags ?? [],
              sourceVersionId: seed.sourceVersionId,
            }
          : {}),
      };
  return (
    <PublishForm
      key={`${viewer.user.id}:${id ?? sourceId ?? "new"}`}
      initial={initial}
      actor={viewer.user.id}
      locale={locale}
      id={id}
      status={detail?.status}
      origin={detail?.version.origin ?? seed?.origin ?? null}
    />
  );
}

function PublishForm({
  initial,
  actor,
  locale,
  id,
  status,
  origin,
}: {
  initial: PublicationInput;
  actor: string;
  locale: Locale;
  id?: string;
  status?: string;
  origin: CommunityOrigin | null;
}) {
  const router = useRouter();
  const { reloadViewer } = useCommunity();
  const operation = `publish:${id ?? initial.sourceVersionId ?? "new"}`;
  const storage = `open-prompt-draft:${actor}:${id ?? initial.sourceVersionId ?? "new"}`;
  const [draft, setDraft] = useState<PublicationInput>(() => {
    const receipt = readReceipt(actor, operation);
    if (receipt) {
      try {
        return JSON.parse(receipt.body);
      } catch {
        /* Fall through to retained input. */
      }
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(storage) ?? "null");
      return saved &&
        typeof saved.content === "string" &&
        (!id || saved.baseVersion === initial.baseVersion)
        ? { ...initial, ...saved, consent: false }
        : initial;
    } catch {
      return initial;
    }
  });
  const [tags, setTags] = useState(draft.tags.join(", "));
  const [pending, setPending] = useState(!!readReceipt(actor, operation));
  const [preview, setPreview] = useState(pending),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null),
    [storageFailed, setStorageFailed] = useState(false);
  const lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const profileSection = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(storage, JSON.stringify({ ...draft, consent: false }));
    } catch {
      queueMicrotask(() => setStorageFailed(true));
    }
  }, [draft, storage]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (draft.title || draft.content || pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [draft.title, draft.content, pending]);
  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  function field<K extends keyof PublicationInput>(key: K, value: PublicationInput[K]) {
    setError(null);
    setDraft((current) => ({
      ...current,
      [key]: value,
      consent: key === "consent" ? (value as boolean) : false,
    }));
  }
  function descriptor(value: PromptDescriptor) {
    setTags(value.tags.join(", "));
    setError(null);
    setDraft((current) => ({ ...current, ...value, consent: false }));
  }
  async function publish() {
    if (lock.current || !draft.consent) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await communityMutation<{ publicId: string; versionNumber: number }>(
        actor,
        operation,
        `/api/community${id ? `/${id}` : ""}`,
        id ? "PUT" : "POST",
        draft,
      );
      sessionStorage.removeItem(storage);
      reloadViewer();
      router.replace(`/${locale}/open-prompts/${result.publicId}?version=${result.versionNumber}`);
    } catch (e) {
      setPending(!!readReceipt(actor, operation));
      setError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function withdraw() {
    if (!id || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await communityFetch(`/api/community/${id}`, { method: "DELETE" });
      dialog.current?.close();
      sessionStorage.removeItem(storage);
      router.replace(`/${locale}/open-prompts/me`);
    } catch (e) {
      setError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  let trimmedTags: string[] = [],
    invalidTags = false;
  try {
    trimmedTags = normalizeTags(
      tags
        .split(/[,，]/)
        .map((value) => value.trim())
        .filter(Boolean),
    );
  } catch {
    invalidTags = true;
  }
  return (
    <div className="op-publish-wrap">
      <Link className="op-back" href={`/${locale}/open-prompts${id ? "/me" : ""}`}>
        <ArrowLeft size={16} aria-hidden="true" />
        {text(locale, "Back to community", "返回社区")}
      </Link>
      <header className="op-page-intro">
        <h1>
          {id
            ? text(locale, "Update publication", "更新社区作品")
            : text(locale, "Share a Prompt", "发布 Prompt")}
        </h1>
        <p>
          {text(
            locale,
            "Preview the content and confirm its license before publishing.",
            "预览公开内容，确认授权后发布。",
          )}
        </p>
      </header>
      <ol className="op-stepper" aria-label={text(locale, "Publication steps", "发布步骤")}>
        <li aria-current={!preview ? "step" : undefined}>
          <span>{preview ? <Check size={14} aria-hidden="true" /> : "1"}</span>
          {text(locale, "Prepare", "填写内容")}
        </li>
        <li aria-current={preview ? "step" : undefined}>
          <span>2</span>
          {text(locale, "Preview & publish", "预览并发布")}
        </li>
      </ol>
      {storageFailed && (
        <p className="op-error" role="alert">
          {text(
            locale,
            "Browser storage is unavailable. Keep this page open to preserve your input.",
            "浏览器存储不可用，请保持此页面打开以保留输入。",
          )}
        </p>
      )}
      {!!error && (
        <p ref={errorRef} tabIndex={-1} className="op-error" role="alert">
          {errorText(error, locale)}
        </p>
      )}
      {pending && (
        <p className="op-notice" role="status">
          {text(
            locale,
            "A publication result is unconfirmed. The original request is retained; retry below to reconcile it.",
            "上次发布结果待确认。已保留原始请求，请点击下方按钮核对，不会重复发布。",
          )}
        </p>
      )}
      {!preview ? (
        <form
          className="op-publish-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (invalidTags) return;
            setDraft((d) => ({ ...d, tags: trimmedTags, consent: false }));
            setError(null);
            setPreview(true);
          }}
        >
          <section className="op-form-section">
            <div className="op-section-heading">
              <h2>{text(locale, "Prompt content", "作品内容")}</h2>
              <span>{text(locale, "Required", "必填")}</span>
            </div>
            <label className="op-field">
              {text(locale, "Title", "标题")}
              <input
                className="op-input"
                required
                maxLength={120}
                value={draft.title}
                onChange={(e) => field("title", e.target.value)}
                placeholder={text(locale, "A clear, specific name", "例如：把复杂概念讲给初学者听")}
              />
            </label>
            <label className="op-field">
              {text(locale, "What does it help with?", "简短用途")}
              <textarea
                className="op-input"
                required
                maxLength={500}
                rows={2}
                value={draft.summary}
                onChange={(e) => field("summary", e.target.value)}
                placeholder={text(
                  locale,
                  "Describe the task and the result someone can expect.",
                  "描述适合什么任务，以及希望得到什么结果。请避免夸大效果。",
                )}
              />
            </label>
            <div className="op-form-grid">
              <label className="op-field">
                {text(locale, "Content language", "正文语言")}
                <select
                  className="op-input"
                  value={draft.language}
                  onChange={(e) =>
                    field("language", e.target.value as PublicationInput["language"])
                  }
                >
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                  <option value="other">{text(locale, "Other", "其他")}</option>
                </select>
              </label>
            </div>
            <label className="op-field">
              {text(locale, "Complete Prompt", "完整 Prompt 正文")}
              <textarea
                className="op-input op-content-input"
                required
                maxLength={100000}
                rows={13}
                value={draft.content}
                readOnly={!!draft.sourceVersionId}
                onChange={(e) => field("content", e.target.value)}
                placeholder={text(
                  locale,
                  "Paste your complete Prompt. Use {{variables}} for values people can replace.",
                  "粘贴完整提示词，可用 {{变量名}} 标记需要替换的内容。",
                )}
              />
            </label>
            {draft.sourceVersionId && (
              <p className="op-notice">
                {text(
                  locale,
                  "This is the exact saved version selected in your workspace. To change the body, edit and save a new private version, then publish that version.",
                  "当前正文来自你选中的已保存版本。若要修改，请先在工作台保存新版本，再选择该版本发布。",
                )}
              </p>
            )}
            <p className="op-caption">
              {text(
                locale,
                "Check for private information, secrets and third-party Skill text before sharing.",
                "发布前请检查个人隐私、密钥及无权共享的第三方 Skill 原文。",
              )}
            </p>
          </section>
          <details
            className="op-form-section op-optional"
            open={!!initial.purposes?.length || !!initial.tags.length}
          >
            <summary>
              <h2>{text(locale, "Make it easier to use", "补充使用提示")}</h2>
              <span>{text(locale, "Optional", "选填")}</span>
            </summary>
            <div className="op-optional-fields">
              <fieldset className="op-purpose-picker">
                <legend>
                  {text(
                    locale,
                    "Purposes (optional, choose more than one)",
                    "用途（选填，可多选）",
                  )}
                </legend>
                <div>
                  {purposes.map((purpose) => (
                    <label className="op-checkbox" key={purpose.id}>
                      <input
                        type="checkbox"
                        checked={draft.purposes?.includes(purpose.id) ?? false}
                        onChange={(event) =>
                          field(
                            "purposes",
                            event.target.checked
                              ? [...(draft.purposes ?? []), purpose.id]
                              : (draft.purposes ?? []).filter((id) => id !== purpose.id),
                          )
                        }
                      />
                      <span>{purpose.name[locale]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="op-actions">
                <button
                  type="button"
                  className="op-button"
                  onClick={() =>
                    descriptor(
                      suggestPromptDescriptor(
                        `${draft.title}\n${draft.summary}\n${draft.content}`,
                        locale,
                      ),
                    )
                  }
                >
                  {text(locale, "Suggest purposes and tags", "建议用途与标签")}
                </button>
                <button
                  type="button"
                  className="op-button"
                  onClick={() => descriptor({ purposes: [], tags: [] })}
                >
                  {text(locale, "Clear purposes and tags", "清空用途与标签")}
                </button>
              </div>
              <label className="op-field">
                {text(locale, "Tags", "标签")}
                <input
                  className="op-input"
                  value={tags}
                  maxLength={492}
                  onChange={(e) => {
                    setTags(e.target.value);
                    field(
                      "tags",
                      e.target.value
                        .split(/[,，]/)
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    );
                  }}
                  placeholder={text(
                    locale,
                    "Up to 12 tags, separated by commas",
                    "用逗号分隔，最多 12 个标签",
                  )}
                />
              </label>
              {invalidTags && (
                <p className="op-error">
                  {text(
                    locale,
                    "Use at most 12 plain-text tags, with at most 40 characters each; remove links or markup.",
                    "最多 12 个纯文本标签，每个最多 40 字；请移除链接或标记。",
                  )}
                </p>
              )}
              {(
                [
                  [
                    "variables",
                    "Variables",
                    "变量说明",
                    "{{topic}} — the topic to explain",
                    "{{主题}}：希望解释的主题",
                  ],
                  [
                    "modelNotes",
                    "Suggested models",
                    "适用模型",
                    "Author recommendations; no verification claim",
                    "填写作者的使用建议，不作为平台验证结果",
                  ],
                  [
                    "exampleInput",
                    "Example input",
                    "示例输入",
                    "A short example of what someone might enter",
                    "示例用户会输入什么",
                  ],
                  [
                    "exampleOutput",
                    "Example output",
                    "示例输出",
                    "Illustrative output, provided by you",
                    "作者提供的示例结果",
                  ],
                  [
                    "usageNotes",
                    "Tips & limitations",
                    "使用建议与注意事项",
                    "What to adjust or double-check",
                    "说明需要调整或自行核查的内容",
                  ],
                ] as const
              ).map(([key, en, zh, hintEn, hintZh]) => (
                <label className="op-field" key={key}>
                  {text(locale, en, zh)}
                  <textarea
                    className="op-input"
                    maxLength={key === "exampleOutput" ? 10000 : 4000}
                    rows={3}
                    value={draft[key]}
                    onChange={(e) => field(key, e.target.value)}
                    placeholder={text(locale, hintEn, hintZh)}
                  />
                </label>
              ))}
            </div>
          </details>
          <details
            ref={profileSection}
            className="op-form-section op-optional"
            open={!initial.authorName}
          >
            <summary>
              <h2>{text(locale, "Public profile", "公开昵称与简介")}</h2>
              <span>{draft.authorName}</span>
            </summary>
            <label className="op-field">
              {text(locale, "Public display name", "公开昵称")}
              <input
                className="op-input"
                required
                maxLength={60}
                value={draft.authorName}
                onInvalid={() => {
                  if (profileSection.current) profileSection.current.open = true;
                }}
                onChange={(e) => field("authorName", e.target.value)}
                placeholder={text(
                  locale,
                  "Choose a name, not an email address",
                  "使用昵称，请勿填写邮箱",
                )}
              />
            </label>
            <label className="op-field">
              {text(locale, "A short bio (optional)", "一句话简介（选填）")}
              <textarea
                className="op-input"
                rows={2}
                maxLength={300}
                value={draft.authorBio}
                onChange={(e) => field("authorBio", e.target.value)}
              />
            </label>
            <p className="op-caption">
              {text(
                locale,
                "This name and bio appear on your publications. Your account email is never used as your public name.",
                "昵称和简介展示在你的公开作品中，账号邮箱不会自动成为公开昵称。",
              )}
            </p>
          </details>
          {id && (
            <section className="op-form-section">
              <h2>{text(locale, "What changed?", "这一版改进了什么？")}</h2>
              <label className="op-field">
                {text(locale, "Change note", "更新说明")}
                <textarea
                  className="op-input"
                  required
                  maxLength={1000}
                  rows={3}
                  value={draft.changeNote}
                  onChange={(e) => field("changeNote", e.target.value)}
                />
              </label>
              <p className="op-caption">
                {text(
                  locale,
                  "Keep the same purpose for updates. A different task should become a new publication with its own Stars.",
                  "更新请保持同一用途。若更换主要任务，应发布为新作品，独立积累 Star。",
                )}
              </p>
            </section>
          )}
          <div className="op-form-actions">
            <span className="op-muted">
              {text(
                locale,
                "Draft retained in this tab for your account",
                "草稿按账号保留在当前标签页",
              )}
            </span>
            <button className="op-button op-primary" type="submit">
              <Eye size={17} aria-hidden="true" />
              {text(locale, "Preview publication", "预览发布内容")}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </form>
      ) : (
        <section className="op-preview">
          <h2 ref={previewHeading} tabIndex={-1}>
            {text(locale, "This is what you will share", "即将公开的内容")}
          </h2>
          <div className="op-preview-header">
            <PurposeLabels values={draft.purposes ?? []} locale={locale} />
            <h3>{draft.title}</h3>
            <p>{draft.summary}</p>
            <div className="op-author">
              <span className="op-avatar">{Array.from(draft.authorName)[0]}</span>
              {draft.authorName}
            </div>
            {draft.authorBio && <p className="op-muted">{draft.authorBio}</p>}
            {draft.tags.length > 0 && (
              <p className="op-muted">{draft.tags.map((t) => `#${t}`).join(" · ")}</p>
            )}
          </div>
          <PromptBody content={draft.content} locale={locale} />
          {origin && (
            <div className="op-note-section">
              <h3>{text(locale, "Built on an open Prompt", "基于开放作品改进")}</h3>
              <p>
                {origin.available ? (
                  <Link
                    href={`/${locale}/open-prompts/${origin.publicId}?version=${origin.versionNumber}`}
                  >
                    {origin.title} · v{origin.versionNumber}
                  </Link>
                ) : (
                  text(
                    locale,
                    "The original publication is no longer available.",
                    "原作品已停止公开展示。",
                  )
                )}
              </p>
            </div>
          )}
          {(
            [
              ["variables", "Variables", "变量说明"],
              ["modelNotes", "Model suggestions (author-provided)", "适用模型（作者填写）"],
              ["exampleInput", "Example input", "示例输入"],
              ["exampleOutput", "Example output (illustrative)", "示例输出（作者提供）"],
              ["usageNotes", "Tips & limitations", "使用建议与注意事项"],
              ["changeNote", "Change note", "更新说明"],
            ] as const
          ).map(
            ([key, en, zh]) =>
              draft[key] && (
                <div className="op-note-section" key={key}>
                  <h3>{text(locale, en, zh)}</h3>
                  <p>{draft[key]}</p>
                </div>
              ),
          )}
          <div className="op-consent-box">
            <Globe2 size={22} aria-hidden="true" />
            <div>
              <h3>{text(locale, "Share freely, by choice", "自愿共享，自由使用")}</h3>
              <p>
                {text(
                  locale,
                  "Anyone can read, copy, adapt and use this content commercially under CC0 1.0, without required attribution. You may withdraw the publication from this site, but cannot revoke licenses or copies already obtained.",
                  "所有人可依据 CC0 1.0 阅读、复制、改编和商业使用，不要求署名。你可撤回本站展示，但无法收回已获得的副本或有效授权。",
                )}
              </p>
              <a
                href="https://creativecommons.org/publicdomain/zero/1.0/"
                target="_blank"
                rel="noopener noreferrer"
              >
                {text(locale, "Read CC0 1.0", "阅读 CC0 1.0 授权说明")} ↗
              </a>
              <label className="op-checkbox">
                <input
                  type="checkbox"
                  checked={draft.consent}
                  disabled={pending || busy}
                  onChange={(e) => field("consent", e.target.checked)}
                />
                <span>
                  {text(
                    locale,
                    "I have the right to share this content, have checked the public preview, and voluntarily agree to CC0 1.0. It contains no private information or unauthorized third-party material.",
                    "我有权分享这些内容，已检查公开预览，并自愿同意 CC0 1.0 授权。内容不包含隐私或未经授权的第三方材料。",
                  )}
                </span>
              </label>
            </div>
          </div>
          <div className="op-form-actions">
            <button
              className="op-button"
              disabled={busy || pending}
              onClick={() => {
                setPreview(false);
                field("consent", false);
              }}
            >
              {text(locale, "Back to editing", "返回编辑")}
            </button>
            <button
              className="op-button op-primary"
              disabled={!draft.consent || busy}
              onClick={() => void publish()}
            >
              <Send size={17} aria-hidden="true" />
              {busy
                ? text(locale, "Publishing…", "正在发布…")
                : pending
                  ? text(locale, "Reconcile publication", "核对此次发布")
                  : id
                    ? text(locale, "Publish update", "发布更新")
                    : text(locale, "Confirm publication", "确认发布")}
            </button>
          </div>
        </section>
      )}
      {id && status === "PUBLISHED" && (
        <section className="op-withdraw">
          <h2>{text(locale, "Withdraw this publication", "撤回这条作品")}</h2>
          <p>
            {text(
              locale,
              "Remove every public version from this site. Existing private copies remain with their owners.",
              "停止在本站展示所有公开版本。其他用户已保存的私人副本仍会保留。",
            )}
          </p>
          <button
            className="op-button op-danger"
            disabled={busy || pending}
            onClick={() => dialog.current?.showModal()}
          >
            {text(locale, "Withdraw…", "撤回发布…")}
          </button>
        </section>
      )}
      <dialog ref={dialog} className="op-dialog" aria-labelledby="withdraw-title">
        <div className="op-dialog-heading">
          <h2 id="withdraw-title">{text(locale, "Withdraw this Prompt?", "撤回这条 Prompt？")}</h2>
          <button
            className="op-button op-icon"
            aria-label={text(locale, "Close", "关闭")}
            onClick={() => dialog.current?.close()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p>
          {text(
            locale,
            "It will disappear from the community, rankings and all public version links. Previously granted licenses and saved copies remain valid.",
            "它将从社区、排行榜和所有公开版本链接中移除。已授予的授权和已保存副本继续有效。",
          )}
        </p>
        {!!error && (
          <p className="op-error" role="alert">
            {errorText(error, locale)}
          </p>
        )}
        <div className="op-actions">
          <button className="op-button" onClick={() => dialog.current?.close()}>
            {text(locale, "Keep published", "继续公开")}
          </button>
          <button className="op-button op-danger" disabled={busy} onClick={() => void withdraw()}>
            {busy
              ? text(locale, "Withdrawing…", "正在撤回…")
              : text(locale, "Confirm withdrawal", "确认撤回")}
          </button>
        </div>
      </dialog>
    </div>
  );
}
