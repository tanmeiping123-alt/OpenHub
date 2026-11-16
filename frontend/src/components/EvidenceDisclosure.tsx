import type { ReactNode } from "react";
import type { Locale } from "@/lib/types";

export function EvidenceDisclosure({
  locale,
  label,
  children,
}: {
  locale: Locale;
  label?: string;
  children: ReactNode;
}) {
  const title = locale === "zh-CN" ? "查看依据" : "View evidence";
  return (
    <details className="evidence-disclosure">
      <summary>
        {title}
        {label ? ` · ${label}` : ""}
      </summary>
      <div className="stack evidence-content">{children}</div>
    </details>
  );
}
