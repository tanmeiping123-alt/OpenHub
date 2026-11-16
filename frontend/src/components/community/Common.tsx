"use client";
import Link from "next/link";
import { ArrowLeft, ArrowRight, SearchX, Star } from "lucide-react";
import type { CommunityCard } from "@/lib/community-types";
import type { Locale } from "@/lib/types";
import { legacyPurposes, purposes, type PurposeId } from "@/lib/prompt-description";
import { dateLabel, errorText, text } from "./client";

export function PurposeLabels({ values, locale }: { values: PurposeId[]; locale: Locale }) {
  return (
    <div className="op-purpose-labels">
      {values.map((id) => (
        <span className="op-category" key={id}>
          {purposes.find((purpose) => purpose.id === id)?.name[locale]}
        </span>
      ))}
    </div>
  );
}

export function CommunityLoading({ locale }: { locale: Locale }) {
  return (
    <div className="op-loading" role="status">
      <div className="op-skeleton" />
      <div className="op-skeleton" />
      <span>{text(locale, "Loading community…", "正在加载社区…")}</span>
    </div>
  );
}
export function CommunityFailure({
  error,
  locale,
  retry,
}: {
  error: unknown;
  locale: Locale;
  retry: () => void;
}) {
  return (
    <section className="op-state" role="alert">
      <SearchX size={30} aria-hidden="true" />
      <h2>{text(locale, "Unable to show this content", "暂时无法显示内容")}</h2>
      <p>{errorText(error, locale)}</p>
      <div className="op-actions">
        <button className="op-button" onClick={retry}>
          {text(locale, "Try again", "重试")}
        </button>
        <Link className="op-button op-primary" href={`/${locale}/open-prompts`}>
          {text(locale, "Explore Prompts", "返回社区")}
        </Link>
      </div>
    </section>
  );
}
export function PromptCard({
  item,
  locale,
  manage = false,
}: {
  item: CommunityCard;
  locale: Locale;
  manage?: boolean;
}) {
  return (
    <article className="op-card">
      <div className="op-card-top">
        <PurposeLabels values={item.purposes ?? legacyPurposes(item.taskType)} locale={locale} />
        <span className="op-count" title={`${item.stars} Stars`}>
          <Star size={15} aria-hidden="true" />
          {new Intl.NumberFormat(locale).format(item.stars)}
        </span>
      </div>
      <h2>
        <Link
          aria-label={item.title}
          href={`/${locale}/open-prompts/${item.id}${item.status !== "PUBLISHED" ? "/edit" : ""}`}
        >
          {item.title}
        </Link>
      </h2>
      <p className="op-card-summary">{item.summary}</p>
      <div className="op-tags">
        {item.tags.slice(0, 3).map((tag) => (
          <Link key={tag} href={`/${locale}/open-prompts?tag=${encodeURIComponent(tag)}`}>
            #{tag}
          </Link>
        ))}
      </div>
      <div className="op-card-bottom">
        <Link className="op-author" href={`/${locale}/open-prompts/creators/${item.author.id}`}>
          <span className="op-avatar">{Array.from(item.author.name)[0]}</span>
          <span>{item.author.name}</span>
        </Link>
        <span className="op-muted">
          v{item.versionNumber} · {dateLabel(item.firstPublishedAt, locale)}
        </span>
      </div>
      {manage && (
        <div className="op-card-manage">
          <span className={`op-status op-status-${item.status.toLowerCase()}`}>
            {item.status === "PUBLISHED"
              ? text(locale, "Published", "已发布")
              : item.status === "WITHDRAWN"
                ? text(locale, "Withdrawn", "已撤回")
                : text(locale, "Removed", "已下架")}
          </span>
          {item.status !== "REMOVED" && (
            <Link href={`/${locale}/open-prompts/${item.id}/edit`}>
              {text(locale, "Manage / update", "管理 / 更新")}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </div>
      )}
    </article>
  );
}
export function Pagination({
  page,
  total,
  pageSize,
  onPage,
  locale,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  locale: Locale;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages === 1) return null;
  return (
    <nav className="op-pagination" aria-label={text(locale, "Pagination", "分页")}>
      <button className="op-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ArrowLeft size={16} aria-hidden="true" />
        {text(locale, "Previous", "上一页")}
      </button>
      <span>
        {page} / {pages}
      </span>
      <button className="op-button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {text(locale, "Next", "下一页")}
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </nav>
  );
}
