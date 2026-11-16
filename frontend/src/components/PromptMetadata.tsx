import { descriptorForPrompt, purposes } from "@/lib/prompt-description";
import type { Locale, Prompt } from "@/lib/types";

export function PromptMetadata({
  prompt,
  locale,
  tags = false,
}: {
  prompt: Pick<Prompt, "taskType" | "descriptor">;
  locale: Locale;
  tags?: boolean;
}) {
  const descriptor = descriptorForPrompt(prompt);
  return (
    <div
      className="row prompt-metadata"
      aria-label={locale === "zh-CN" ? "用途与标签" : "Purposes and tags"}
    >
      {descriptor.purposes.length ? (
        descriptor.purposes.map((id) => (
          <span className="badge blue" key={id}>
            {purposes.find((p) => p.id === id)!.name[locale]}
          </span>
        ))
      ) : (
        <span className="badge">{locale === "zh-CN" ? "未分类" : "Uncategorized"}</span>
      )}
      {tags &&
        descriptor.tags.map((tag) => (
          <span className="badge" key={`tag:${tag}`}>
            {tag}
          </span>
        ))}
    </div>
  );
}
