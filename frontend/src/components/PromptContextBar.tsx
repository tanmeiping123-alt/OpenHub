"use client";
import Link from "next/link";
import { PencilLine, WandSparkles, ListChecks, Play, Share2, FileText } from "lucide-react";
import type { Locale, Prompt, PromptVersion } from "@/lib/types";
import { localizedTitleFor } from "@/lib/fixtures";
import { promptActionHref, type PromptAction } from "@/lib/prompt-navigation";

export function PromptContextBar({
  locale,
  prompt,
  version,
  active,
  unsaved = false,
}: {
  locale: Locale;
  prompt: Prompt;
  version: PromptVersion;
  active: PromptAction;
  unsaved?: boolean;
}) {
  const zh = locale === "zh-CN";
  const actions = [
    { action: "edit", label: zh ? "编辑" : "Edit", icon: PencilLine },
    { action: "evaluate", label: zh ? "评估" : "Evaluate", icon: ListChecks },
    { action: "optimize", label: zh ? "优化" : "Optimize", icon: WandSparkles },
    { action: "playground", label: zh ? "试跑" : "Run", icon: Play },
    { action: "share", label: zh ? "分享" : "Share", icon: Share2 },
  ] as const;
  return (
    <nav className="prompt-context" aria-label={zh ? "当前 Prompt 操作" : "Current Prompt actions"}>
      <div className="prompt-context-identity">
        <FileText size={19} aria-hidden="true" />
        <div>
          <strong>{localizedTitleFor(prompt.id, locale, version.title)}</strong>
          <span>
            v{version.number} ·{" "}
            {unsaved
              ? zh
                ? "有未保存修改"
                : "Unsaved edits"
              : zh
                ? "已保存版本"
                : "Saved version"}
          </span>
        </div>
      </div>
      <div className="prompt-context-actions">
        {actions.map(({ action, label, icon: Icon }) =>
          unsaved && action === "share" ? (
            <button
              key={action}
              className="context-action"
              disabled
              title={zh ? "保存修改后分享" : "Save edits before sharing"}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          ) : (
            <Link
              key={action}
              className={`context-action ${active === action ? "selected" : ""}`}
              aria-current={active === action ? "page" : undefined}
              href={promptActionHref(locale, prompt.id, version.id, action)}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </Link>
          ),
        )}
      </div>
    </nav>
  );
}
