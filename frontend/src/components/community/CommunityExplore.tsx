"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Search, SlidersHorizontal, Sprout } from "lucide-react";
import type { CommunityAuthor, CommunityPage } from "@/lib/community-types";
import { purposes } from "@/lib/prompt-description";
import { text, useCommunityResource } from "./client";
import { CommunityFailure, CommunityLoading, Pagination, PromptCard } from "./Common";
import { useCommunity } from "./CommunityShell";

function useFilterInput(value: string) {
  const [draft, setDraft] = useState({ source: value, value });
  if (draft.source !== value) setDraft({ source: value, value });
  return [
    draft.source === value ? draft.value : value,
    (next: string) => setDraft({ source: value, value: next }),
  ] as const;
}

export function CommunityExplore({
  authorId,
  personal = false,
}: {
  authorId?: string;
  personal?: boolean;
}) {
  const { locale, viewer } = useCommunity();
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useFilterInput(params.get("q") ?? "");
  const [tagInput, setTagInput] = useFilterInput(params.get("tag") ?? "");
  const keyword = params.get("q")?.trim() ?? "";
  const requestedSort = params.get("sort");
  const sort =
      requestedSort === "relevance" && !keyword
        ? "stars"
        : (requestedSort ?? (keyword ? "relevance" : "stars")),
    purpose = params.get("purpose") ?? "",
    tag = params.get("tag") ?? "",
    category = params.get("category") ?? "",
    language = params.get("language") ?? "";
  const tab = params.get("tab") === "starred" ? "starred" : "published";
  const page = Number(params.get("page")) || 1;
  const filter = new URLSearchParams({
    q: params.get("q") ?? "",
    sort,
    category,
    purpose,
    tag,
    language,
    page: String(page),
  });
  if (authorId) filter.set("author", authorId);
  const listing = useCommunityResource<CommunityPage>(
    personal ? `/api/community/me?tab=${tab}&page=${page}` : `/api/community?${filter}`,
  );
  const author = useCommunityResource<CommunityAuthor>(
    authorId ? `/api/community/creators/${encodeURIComponent(authorId)}` : null,
  );
  function change(values: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    next.delete("page");
    Object.entries(values).forEach(([key, value]) =>
      value ? next.set(key, value) : next.delete(key),
    );
    router.push(
      `/${locale}/open-prompts${personal ? "/me" : authorId ? `/creators/${authorId}` : ""}${next.size ? `?${next}` : ""}`,
      { scroll: false },
    );
  }
  return (
    <>
      {personal ? (
        <section className="op-page-intro">
          <h1>{text(locale, "My community", "我的社区")}</h1>
          <p>
            {text(
              locale,
              "Manage your publications and return to the Prompts you love.",
              "管理已发布的作品，随时回到你认可的 Prompt。",
            )}
          </p>
          <div
            className="op-tabs"
            role="group"
            aria-label={text(locale, "My community", "我的社区")}
          >
            <button aria-pressed={tab === "published"} onClick={() => change({ tab: "published" })}>
              {text(locale, "My publications", "我的发布")}
            </button>
            <button aria-pressed={tab === "starred"} onClick={() => change({ tab: "starred" })}>
              {text(locale, "Starred", "已 Star")}
            </button>
          </div>
        </section>
      ) : authorId ? (
        <section className="op-page-intro op-creator-intro">
          <Link className="op-back" href={`/${locale}/open-prompts`}>
            {text(locale, "← Back to community", "← 返回社区")}
          </Link>
          {author.loading ? (
            <CommunityLoading locale={locale} />
          ) : author.error ? (
            <CommunityFailure locale={locale} error={author.error} retry={author.reload} />
          ) : (
            <>
              <span className="op-avatar op-avatar-large">
                {Array.from(author.data?.name ?? "")[0]}
              </span>
              <h1>{author.data?.name}</h1>
              <p>
                {author.data?.bio ||
                  text(locale, "A creator sharing useful ideas.", "一位正在分享好想法的创作者。")}
              </p>
            </>
          )}
        </section>
      ) : (
        <section className="op-page-intro op-explore-intro">
          <h1>{text(locale, "Find your next Prompt", "发现好用的 Prompt")}</h1>
        </section>
      )}
      {!personal && (
        <section className="op-discovery" aria-label={text(locale, "Find Prompts", "查找 Prompt")}>
          <form
            className="op-search"
            onSubmit={(e) => {
              e.preventDefault();
              change({
                q: query.trim(),
                ...(requestedSort === "relevance" && !query.trim() ? { sort: "" } : {}),
              });
            }}
          >
            <Search size={20} aria-hidden="true" />
            <input
              aria-label={text(locale, "Search Prompts", "搜索 Prompt")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={text(
                locale,
                "What do you want to create?",
                "你想完成什么？试试写作、代码、学习…",
              )}
              maxLength={160}
            />
            <button className="op-button op-primary" type="submit">
              {text(locale, "Search", "搜索")}
            </button>
          </form>
          <div className="op-filter-row">
            <div
              className="op-category-list"
              role="group"
              aria-label={text(locale, "Purposes", "用途")}
            >
              <button
                aria-pressed={!purpose && !category}
                onClick={() => change({ purpose: "", category: "" })}
              >
                {text(locale, "All Prompts", "全部")}
              </button>
              {purposes.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={purpose === item.id}
                  onClick={() => change({ purpose: item.id, category: "" })}
                >
                  {item.name[locale]}
                </button>
              ))}
            </div>
            <label className="op-language-filter">
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span className="op-sr-only">{text(locale, "Prompt language", "Prompt 语言")}</span>
              <select value={language} onChange={(e) => change({ language: e.target.value })}>
                <option value="">{text(locale, "All languages", "全部语言")}</option>
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
                <option value="other">{text(locale, "Other", "其他")}</option>
              </select>
            </label>
          </div>
          <form
            className="op-tag-filter"
            onSubmit={(event) => {
              event.preventDefault();
              change({ tag: tagInput.trim() });
            }}
          >
            <label>
              <span>{text(locale, "Tag", "标签")}</span>
              <input
                className="op-input"
                aria-label={text(locale, "Filter by tag", "按标签筛选")}
                maxLength={40}
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                placeholder={text(locale, "e.g. resume", "例如：简历优化")}
              />
            </label>
            <button type="submit" className="op-button">
              {text(locale, "Apply tag", "筛选标签")}
            </button>
            {tag && (
              <button
                type="button"
                className="op-button"
                onClick={() => {
                  setTagInput("");
                  change({ tag: "" });
                }}
              >
                {text(locale, "Clear tag", "清除标签")}
              </button>
            )}
          </form>
          <div className="op-list-heading">
            <div className="op-tabs" role="group" aria-label={text(locale, "Sort Prompts", "排序")}>
              {!!params.get("q")?.trim() && (
                <button
                  aria-pressed={sort === "relevance"}
                  onClick={() => change({ sort: "relevance" })}
                >
                  {text(locale, "Most relevant", "最相关")}
                </button>
              )}
              <button aria-pressed={sort === "stars"} onClick={() => change({ sort: "stars" })}>
                {text(locale, "Most starred", "总 Star 榜")}
              </button>
              <button aria-pressed={sort === "recent"} onClick={() => change({ sort: "recent" })}>
                {text(locale, "Past 7 days", "近 7 天")}
              </button>
              <button aria-pressed={sort === "newest"} onClick={() => change({ sort: "newest" })}>
                {text(locale, "Newest", "最新发布")}
              </button>
            </div>
            <span className="op-muted" aria-live="polite">
              {listing.data
                ? text(locale, `${listing.data.total} Prompts`, `${listing.data.total} 条 Prompt`)
                : ""}
            </span>
          </div>
          <details className="op-ranking-note">
            <summary>{text(locale, "About this ranking", "排序说明")}</summary>
            <p>
              {sort === "relevance"
                ? text(
                    locale,
                    "Matches in titles, descriptions, tags and Prompt text. Stars break ties.",
                    "按标题、说明、标签和正文与关键词的匹配程度排序，匹配相同时参考 Star。",
                  )
                : sort === "recent"
                  ? text(
                      locale,
                      "Active Stars first added in the past 7 days. Re-starring does not reset the clock.",
                      "统计近 7 天首次添加且仍有效的 Star；取消后重加不会刷新时间。",
                    )
                  : sort === "newest"
                    ? text(
                        locale,
                        "Freshly published ideas, including those waiting for their first Star.",
                        "按首次发布时间排列，让新作品也有机会被发现。",
                      )
                    : text(
                        locale,
                        "Ranked by real community Stars. Popularity is not a verified quality score.",
                        "按社区真实 Star 排序。人气代表认可，不代表效果认证。",
                      )}
            </p>
          </details>
        </section>
      )}
      {listing.loading ? (
        <CommunityLoading locale={locale} />
      ) : listing.error ? (
        <CommunityFailure error={listing.error} locale={locale} retry={listing.reload} />
      ) : listing.data?.items.length ? (
        <>
          <div className="op-card-grid">
            {listing.data.items.map((item) => (
              <PromptCard
                key={item.id}
                item={item}
                locale={locale}
                manage={personal && tab === "published"}
              />
            ))}
          </div>
          <Pagination
            {...listing.data}
            locale={locale}
            onPage={(value) => change({ page: String(value) })}
          />
        </>
      ) : (
        <section className="op-state">
          <Sprout size={38} aria-hidden="true" />
          <h2>
            {params.get("q") || category || purpose || tag || language
              ? text(locale, "No matching Prompts yet", "还没有匹配的 Prompt")
              : personal && tab === "starred"
                ? text(locale, "Your collection starts with a Star", "从第一颗 Star 开始收藏")
                : text(locale, "A good idea can start here", "第一个好想法，可以从这里开始")}
          </h2>
          <p>
            {text(
              locale,
              "Try another search, or share a useful Prompt of your own.",
              "换个关键词试试，或分享一条你觉得好用的 Prompt。",
            )}
          </p>
          <div className="op-actions">
            {(params.get("q") || category || purpose || tag || language) && (
              <button
                className="op-button"
                onClick={() => {
                  setQuery("");
                  setTagInput("");
                  change({
                    q: "",
                    category: "",
                    purpose: "",
                    tag: "",
                    language: "",
                    sort: sort === "relevance" ? "" : sort,
                  });
                }}
              >
                {text(locale, "Clear filters", "清除筛选")}
              </button>
            )}
            <Link
              className="op-button op-primary"
              href={`/${locale}/open-prompts/${personal && tab === "starred" ? "" : "new"}`}
            >
              {personal && tab === "starred"
                ? text(locale, "Explore Prompts", "去发现 Prompt")
                : text(locale, "Share a Prompt", "发布 Prompt")}
            </Link>
          </div>
        </section>
      )}
      {viewer?.user && personal && (
        <p className="op-bottom-note">
          {text(
            locale,
            "Your private workspace and community publications are separate. Only what you explicitly publish is public.",
            "私人工作台与社区发布相互独立，只有你主动发布的内容才会公开。",
          )}
        </p>
      )}
    </>
  );
}
