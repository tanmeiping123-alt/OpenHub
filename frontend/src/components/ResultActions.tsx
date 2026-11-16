"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, Download, Pencil } from "lucide-react";
import type { Locale } from "@/lib/types";
import { resultFilename, resultPlainText } from "@/lib/result-export";

export function ResultActions({
  locale,
  content,
  title,
  editHref,
  onEdit,
}: {
  locale: Locale;
  content: string;
  title: string;
  editHref?: string;
  onEdit?: () => void;
}) {
  const [feedback, updateFeedback] = useState<{ content: string; message: string } | null>(null);
  const setFeedback = (message: string) => updateFeedback({ content, message });
  const [busy, setBusy] = useState(false);
  const t = (en: string, zh: string) => (locale === "zh-CN" ? zh : en);
  async function copy(markdown: boolean) {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(markdown ? content : resultPlainText(content));
      setFeedback(
        markdown ? t("Markdown copied.", "已复制 Markdown。") : t("Body copied.", "已复制正文。"),
      );
    } catch {
      setFeedback(
        t(
          "Copy failed. Allow clipboard access or export the file.",
          "复制失败，请允许剪贴板权限或导出文件。",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  function download(format: "md" | "txt") {
    let url: string | undefined;
    let anchor: HTMLAnchorElement | undefined;
    try {
      const body = format === "md" ? content : resultPlainText(content);
      url = URL.createObjectURL(
        new Blob([body], {
          type: `${format === "md" ? "text/markdown" : "text/plain"};charset=utf-8`,
        }),
      );
      anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = resultFilename(title, format);
      document.body.append(anchor);
      anchor.click();
      setFeedback(
        t(
          "Download requested. Check your browser downloads.",
          "已发起下载，请查看浏览器下载记录。",
        ),
      );
    } catch {
      setFeedback(
        t("Export failed. Try copying the result instead.", "导出失败，请尝试复制结果。"),
      );
    } finally {
      anchor?.remove();
      if (url) {
        const objectUrl = url;
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    }
  }
  return (
    <div className="result-actions">
      <div className="result-action-row" role="group" aria-label={t("Result actions", "结果操作")}>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !content}
          onClick={() => void copy(false)}
        >
          <Copy size={15} aria-hidden="true" />
          {t("Copy body", "复制正文")}
        </button>
        <details className="result-export">
          <summary className="btn btn-sm">{t("More", "更多")}</summary>
          <div className="result-action-row">
            <button
              className="btn btn-sm"
              disabled={busy || !content}
              onClick={() => void copy(true)}
            >
              {t("Copy Markdown", "复制 Markdown")}
            </button>
            <button className="btn btn-sm" disabled={!content} onClick={() => download("md")}>
              <Download size={15} aria-hidden="true" />
              Markdown (.md)
            </button>
            <button className="btn btn-sm" disabled={!content} onClick={() => download("txt")}>
              <Download size={15} aria-hidden="true" />
              {t("Plain text (.txt)", "纯文本 (.txt)")}
            </button>
          </div>
        </details>
        {editHref && (
          <Link className="btn btn-sm" href={editHref} onClick={onEdit}>
            <Pencil size={15} aria-hidden="true" />
            {t("Continue editing", "继续编辑")}
          </Link>
        )}
      </div>
      <p className="small subtle" role="status">
        {feedback?.content === content ? feedback.message : ""}
      </p>
    </div>
  );
}
