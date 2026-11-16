import { promptDiff } from "@/lib/prompt-diff";
import type { Locale } from "@/lib/types";

export function PromptDiff({
  before,
  after,
  locale,
}: {
  before: string;
  after: string;
  locale: Locale;
}) {
  const zh = locale === "zh-CN";
  if (before === after)
    return <p role="status">{zh ? "正文没有变化。" : "The body is unchanged."}</p>;
  return (
    <div className="stack prompt-diff" aria-label={zh ? "正文差异" : "Body changes"}>
      <div className="row">
        <span className="diff-removed-label">{zh ? "删除" : "Removed"}</span>
        <span className="diff-added-label">{zh ? "新增" : "Added"}</span>
      </div>
      <div className="diff-body">
        {promptDiff(before, after).map((piece, i) =>
          piece.kind === "same" ? (
            <span key={i}>{piece.text}</span>
          ) : piece.kind === "added" ? (
            <ins key={i}>{piece.text}</ins>
          ) : (
            <del key={i}>{piece.text}</del>
          ),
        )}
      </div>
    </div>
  );
}
