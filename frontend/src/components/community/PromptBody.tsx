"use client";
import { useRef, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import type { Locale } from "@/lib/types";
import { fillPromptVariables, promptVariables } from "@/lib/prompt-variables";
import { text } from "./client";

export function PromptBody({
  content,
  locale,
  fillVariables = false,
}: {
  content: string;
  locale: Locale;
  fillVariables?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const variables = fillVariables ? promptVariables(content) : [];
  const filled = fillPromptVariables(content, values);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  const filledRef = useRef<HTMLPreElement>(null);
  async function copy(filledCopy = false) {
    try {
      await navigator.clipboard.writeText(filledCopy ? filled : content);
      setCopied(!filledCopy);
      setStatus(
        text(
          locale,
          "Prompt copied. Ready to use wherever you like.",
          "已复制 Prompt，可直接粘贴使用。",
        ),
      );
    } catch {
      setCopied(false);
      const target = filledCopy ? filledRef.current : bodyRef.current;
      target?.focus();
      const range = document.createRange();
      if (target) {
        range.selectNodeContents(target);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
      setStatus(
        text(
          locale,
          "Select the text and copy manually; clipboard access was blocked.",
          "剪贴板访问受限。已选中正文，请手动复制。",
        ),
      );
    }
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "open-prompt.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(text(locale, "Download started.", "已开始下载。"));
    } catch {
      setStatus(
        text(locale, "Download failed. You can copy the text instead.", "下载失败，请复制正文。"),
      );
    }
  }
  return (
    <section className="op-body-panel" aria-label={text(locale, "Full Prompt", "完整 Prompt")}>
      <div className="op-body-toolbar">
        <h2>{text(locale, "Prompt", "Prompt 正文")}</h2>
        <div className="op-actions">
          <button
            type="button"
            className="op-button op-icon"
            aria-label={text(locale, "Download text", "下载正文")}
            onClick={download}
          >
            <Download size={17} aria-hidden="true" />
          </button>
          <button type="button" className="op-button op-primary" onClick={() => void copy()}>
            {copied ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
            {text(locale, "Copy original", "复制原文")}
          </button>
        </div>
      </div>
      <pre
        ref={bodyRef}
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-label={text(locale, "Prompt content", "Prompt 正文")}
        tabIndex={0}
        className="op-prompt-body"
      >
        {content}
      </pre>
      {variables.length > 0 && (
        <details className="op-variable-fill">
          <summary>{text(locale, "Fill in variables", "填写变量")}</summary>
          <p className="op-caption">
            {text(
              locale,
              "Values stay on this page. Empty fields keep their placeholders.",
              "填写内容仅留在当前页面；空项保留原占位符。",
            )}
          </p>
          <div className="op-form-grid">
            {variables.map((name) => (
              <label className="op-field" key={name}>
                {name}
                <textarea
                  className="op-input"
                  rows={2}
                  maxLength={10000}
                  value={Object.hasOwn(values, name) ? values[name] : ""}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, [name]: event.target.value }));
                    setCopied(false);
                    setStatus("");
                  }}
                />
              </label>
            ))}
          </div>
          <pre
            ref={filledRef}
            role="textbox"
            aria-readonly="true"
            aria-multiline="true"
            tabIndex={0}
            aria-label={text(locale, "Filled Prompt preview", "变量填写预览")}
            className="op-prompt-body"
          >
            {filled}
          </pre>
          <button type="button" className="op-button" onClick={() => void copy(true)}>
            <Copy size={16} aria-hidden="true" />
            {text(locale, "Copy filled Prompt", "复制填写后的 Prompt")}
          </button>
        </details>
      )}
      <p className="op-copy-status" role="status">
        {status}
      </p>
    </section>
  );
}
