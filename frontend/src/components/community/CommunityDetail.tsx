"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookmarkPlus,
  Check,
  Flag,
  GitBranch,
  History,
  Share2,
  Star,
  X,
} from "lucide-react";
import type { CommunityDetail as Detail, CommunityReportCategory } from "@/lib/community-types";
import { legacyPurposes } from "@/lib/prompt-description";
import {
  communityFetch,
  communityMutation,
  dateLabel,
  errorText,
  readReceipt,
  text,
  useCommunityResource,
} from "./client";
import { useCommunity } from "./CommunityShell";
import { CommunityFailure, CommunityLoading, PurposeLabels } from "./Common";
import { PromptBody } from "./PromptBody";

export function CommunityDetail({ id }: { id: string }) {
  const { locale, viewer, login, reloadViewer } = useCommunity();
  const search = useSearchParams();
  const router = useRouter();
  const versionQuery = search.get("version");
  const resource = useCommunityResource<Detail>(
    `/api/community/${encodeURIComponent(id)}${versionQuery ? `?version=${encodeURIComponent(versionQuery)}` : ""}`,
  );
  const [busy, setBusy] = useState("");
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [category, setCategory] = useState<CommunityReportCategory>("privacy"),
    [report, setReport] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  if (resource.loading) return <CommunityLoading locale={locale} />;
  if (resource.error)
    return <CommunityFailure error={resource.error} locale={locale} retry={resource.reload} />;
  const item = resource.data;
  if (!item) return null;
  const version = item.version;
  const owner = viewer?.user?.id === item.author.id;
  async function action(kind: string) {
    if (!viewer?.user) {
      router.push(login);
      return;
    }
    if (lock.current || !item) return;
    lock.current = true;
    setBusy(kind);
    setError(null);
    setMessage("");
    try {
      if (kind === "star") {
        await communityFetch(`/api/community/${id}/star`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !viewer.starred, versionNumber: item.version.number }),
        });
        reloadViewer();
        resource.reload();
      } else if (kind === "copy") {
        const result = await communityMutation<{ promptId: string; versionId: string }>(
          viewer.user.id,
          `copy:${id}:${item.version.number}`,
          `/api/community/${id}/copy`,
          "POST",
          { versionNumber: item.version.number },
        );
        setSaved(result.promptId);
        setMessage(
          text(
            locale,
            "Saved as your own independent copy. You can edit it in your workspace.",
            "已保存为你的独立副本，可在工作台继续编辑。",
          ),
        );
      } else {
        await communityMutation(
          viewer.user.id,
          `report:${id}`,
          `/api/community/${id}/report`,
          "POST",
          { category, detail: report.trim() },
        );
        dialog.current?.close();
        setReport("");
        setMessage(
          text(
            locale,
            "Report received. An administrator will review it.",
            "已收到举报，管理员将核查处理。",
          ),
        );
      }
    } catch (e) {
      setError(e);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  return (
    <>
      <div className="op-detail-top">
        <Link className="op-back" href={`/${locale}/open-prompts`}>
          <ArrowLeft size={16} aria-hidden="true" />
          {text(locale, "Explore Prompts", "返回发现")}
        </Link>
        <div className="op-actions">
          {owner && (
            <Link className="op-button" href={`/${locale}/open-prompts/${id}/edit`}>
              {text(locale, "Manage publication", "管理发布")}
            </Link>
          )}
          <button
            className="op-button op-icon"
            aria-label={text(locale, "Copy share link", "复制分享链接")}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setMessage(text(locale, "Link copied.", "已复制分享链接。"));
              } catch {
                setMessage(
                  text(locale, "Copy the link from your address bar.", "请从地址栏复制当前链接。"),
                );
              }
            }}
          >
            <Share2 size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
      <header className="op-detail-heading">
        <div className="op-tags">
          <PurposeLabels values={item.purposes ?? legacyPurposes(item.taskType)} locale={locale} />
          <span>
            {item.language === "zh-CN"
              ? "中文"
              : item.language === "en"
                ? "English"
                : text(locale, "Other language", "其他语言")}
          </span>
          <span>CC0 1.0</span>
        </div>
        <h1>{item.title}</h1>
        <p>{item.summary}</p>
        <div className="op-detail-meta">
          <Link className="op-author" href={`/${locale}/open-prompts/creators/${item.author.id}`}>
            <span className="op-avatar">{Array.from(item.author.name)[0]}</span>
            {item.author.name}
          </Link>
          <span>{dateLabel(version.createdAt, locale)}</span>
          <span>v{version.number}</span>
          {version.number !== item.versionNumber && (
            <span className="op-status">{text(locale, "Historical version", "历史版本")}</span>
          )}
        </div>
      </header>
      <div className="op-detail-grid">
        <div className="op-detail-content">
          <PromptBody
            key={`${id}:${version.number}`}
            content={version.content}
            locale={locale}
            fillVariables
          />
          {[
            [text(locale, "Variables", "变量填写"), version.variables],
            [text(locale, "How to use", "使用说明"), version.usageNotes],
            [text(locale, "Author model suggestions", "作者声称适用的模型"), version.modelNotes],
          ].map(
            ([heading, body]) =>
              body && (
                <section className="op-note-section" key={heading}>
                  <h2>{heading}</h2>
                  <p>{body}</p>
                  {heading === text(locale, "Author model suggestions", "作者声称适用的模型") && (
                    <small className="op-muted">
                      {text(
                        locale,
                        "Provided by the author; not a platform test result.",
                        "由作者填写，不代表平台已试跑或验证。",
                      )}
                    </small>
                  )}
                </section>
              ),
          )}
          {(version.exampleInput || version.exampleOutput) && (
            <section className="op-note-section">
              <h2>{text(locale, "Author example", "作者示例")}</h2>
              <p className="op-muted">
                {text(
                  locale,
                  "Author-provided illustration, not verified execution evidence.",
                  "作者提供的示例，不是平台真实执行证据。",
                )}
              </p>
              <div className="op-example-grid">
                {[
                  [text(locale, "Input", "输入"), version.exampleInput],
                  [text(locale, "Output", "输出"), version.exampleOutput],
                ].map(
                  ([label, body]) =>
                    body && (
                      <div key={label}>
                        <h3>{label}</h3>
                        <pre>{body}</pre>
                      </div>
                    ),
                )}
              </div>
            </section>
          )}
          {item.tags.length > 0 && (
            <div className="op-tags op-detail-tags">
              {item.tags.map((tag) => (
                <Link href={`/${locale}/open-prompts?tag=${encodeURIComponent(tag)}`} key={tag}>
                  #{tag}
                </Link>
              ))}
            </div>
          )}
        </div>
        <aside className="op-detail-aside">
          <div className="op-action-panel">
            <p className="op-caption">
              {text(
                locale,
                "Copy to use immediately. Saving creates your own template; locally filled values are not saved.",
                "复制即可使用。保存会创建独立的原文模板，当前填写的变量值不会保存。",
              )}
            </p>
            <div className="op-popularity">
              <Star size={21} aria-hidden="true" />
              <strong>{new Intl.NumberFormat(locale).format(item.stars)}</strong>
              <span>Stars</span>
            </div>
            <button
              className="op-button op-full"
              disabled={!!busy || owner}
              aria-pressed={viewer?.starred ?? false}
              onClick={() => void action("star")}
            >
              <Star size={17} fill={viewer?.starred ? "currentColor" : "none"} aria-hidden="true" />
              {busy === "star"
                ? text(locale, "Updating…", "正在更新…")
                : owner
                  ? text(locale, "Your publication", "你的作品")
                  : viewer?.starred
                    ? text(locale, "Starred · Unstar", "已 Star · 取消")
                    : text(locale, "Star this Prompt", "为这条 Prompt Star")}
            </button>
            {saved ? (
              <Link className="op-button op-full" href={`/${locale}/app/prompts/${saved}/edit`}>
                <Check size={17} aria-hidden="true" />
                {text(locale, "Edit my copy", "编辑我的副本")}
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            ) : (
              <button
                className="op-button op-full"
                disabled={!!busy}
                onClick={() => void action("copy")}
              >
                <BookmarkPlus size={17} aria-hidden="true" />
                {busy === "copy"
                  ? text(locale, "Saving…", "正在保存…")
                  : text(locale, "Save original template", "保存原文模板副本")}
              </button>
            )}
            {!!error && (
              <p className="op-error" role="alert">
                {errorText(error, locale)}
                {!viewer?.user && <Link href={login}>{text(locale, " Log in", " 登录")}</Link>}
              </p>
            )}
            <p className="op-feedback" role="status">
              {message}
            </p>
          </div>
          <details className="op-aside-section op-disclosure">
            <summary>
              <h2>
                <History size={16} aria-hidden="true" />
                {text(locale, "Published versions", "公开版本")}
              </h2>
              <span>v{version.number}</span>
            </summary>
            <label className="op-sr-only" htmlFor="op-version">
              {text(locale, "Version", "版本")}
            </label>
            <select
              id="op-version"
              className="op-input"
              value={version.number}
              onChange={(e) =>
                router.push(`/${locale}/open-prompts/${id}?version=${e.target.value}`, {
                  scroll: false,
                })
              }
            >
              {item.versions.map((v) => (
                <option key={v.number} value={v.number}>
                  v{v.number} · {dateLabel(v.createdAt, locale)}
                </option>
              ))}
            </select>
            <p>{version.changeNote || text(locale, "First publication", "首次发布")}</p>
          </details>
          {version.origin && (
            <details className="op-aside-section op-disclosure">
              <summary>
                <h2>
                  <GitBranch size={16} aria-hidden="true" />
                  {text(locale, "Built on an open idea", "基于开放作品改进")}
                </h2>
              </summary>
              {version.origin.available ? (
                <Link
                  className="op-origin-link"
                  href={`/${locale}/open-prompts/${version.origin.publicId}?version=${version.origin.versionNumber}`}
                >
                  {version.origin.title} · v{version.origin.versionNumber}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              ) : (
                <p>
                  {text(
                    locale,
                    "Original publication is no longer available.",
                    "原作已撤回或下架。",
                  )}
                </p>
              )}
            </details>
          )}
          <section className="op-aside-section">
            <h2>CC0 1.0</h2>
            <p>
              {text(
                locale,
                "Free to copy, adapt and use commercially.",
                "可自由复制、改编与商业使用。",
              )}
            </p>
            <details className="op-disclosure op-license-details">
              <summary>{text(locale, "License details", "授权详情")}</summary>
              <p>
                {text(
                  locale,
                  "Shared under CC0 1.0. Copy, adapt and use commercially without a required attribution. Other people's rights still apply.",
                  "作者以 CC0 1.0 共享。可复制、改编及商业使用，不要求署名；他人的隐私等权利仍需尊重。",
                )}
              </p>
              <a
                href="https://creativecommons.org/publicdomain/zero/1.0/"
                target="_blank"
                rel="noopener noreferrer"
              >
                {text(locale, "Read the license", "阅读授权说明")} ↗
              </a>
              <details className="op-hash">
                <summary>{text(locale, "Snapshot fingerprint", "快照指纹")}</summary>
                <code>{version.hash}</code>
              </details>
            </details>
          </section>
          <button
            className="op-report-button"
            onClick={() => {
              setError(null);
              if (!viewer?.user) router.push(login);
              else {
                const pendingReport = readReceipt(viewer.user.id, `report:${id}`);
                if (pendingReport) {
                  try {
                    const original = JSON.parse(pendingReport.body);
                    setCategory(original.category);
                    setReport(original.detail);
                  } catch {
                    /* Retain existing input. */
                  }
                }
                dialog.current?.showModal();
              }
            }}
          >
            <Flag size={15} aria-hidden="true" />
            {text(locale, "Report a concern", "举报问题")}
          </button>
        </aside>
      </div>
      <dialog ref={dialog} className="op-dialog" aria-labelledby="report-title">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action("report");
          }}
        >
          <div className="op-dialog-heading">
            <h2 id="report-title">{text(locale, "Report this Prompt", "举报这条 Prompt")}</h2>
            <button
              type="button"
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
              "Tell us what needs attention. A report does not automatically remove content or change Stars.",
              "请说明需要核查的问题。举报不会自动下架内容或更改 Star。",
            )}
          </p>
          <label className="op-field">
            {text(locale, "Reason", "问题类型")}
            <select
              className="op-input"
              value={category}
              onChange={(e) => setCategory(e.target.value as CommunityReportCategory)}
            >
              {[
                ["privacy", "Privacy", "隐私泄露"],
                ["rights", "Rights / impersonation", "侵权 / 冒名"],
                ["spam", "Spam / duplication", "垃圾 / 重复"],
                ["other", "Other", "其他"],
              ].map(([value, en, zh]) => (
                <option key={value} value={value}>
                  {text(locale, en, zh)}
                </option>
              ))}
            </select>
          </label>
          <label className="op-field">
            {text(locale, "Details", "补充说明")}
            <textarea
              className="op-input"
              required
              minLength={5}
              maxLength={2000}
              value={report}
              onChange={(e) => setReport(e.target.value)}
              rows={5}
            />
          </label>
          {!!error && (
            <p className="op-error" role="alert">
              {errorText(error, locale)}
            </p>
          )}
          <button className="op-button op-primary" disabled={!!busy || report.trim().length < 5}>
            {busy === "report"
              ? text(locale, "Sending…", "正在提交…")
              : text(locale, "Submit report", "提交举报")}
          </button>
        </form>
      </dialog>
    </>
  );
}
