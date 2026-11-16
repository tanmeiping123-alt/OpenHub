import type { Locale } from "./types";

export function isWorkspacePath(path: string) {
  return /^\/(en|zh-CN)\/app(?:\/|$)/.test(path);
}

// Only same-language workspace/community paths are valid sign-in return destinations.
export function safeWorkspaceNext(value: unknown, locale: Locale) {
  const fallback = `/${locale}/app`;
  if (typeof value !== "string" || value.length > 2000 || /[\\\u0000-\u001f\u007f]/.test(value))
    return fallback;
  if (
    !(
      value.startsWith(`/${locale}/app`) ||
      value.startsWith(`/${locale}/open-prompts`) ||
      value.startsWith(`/${locale}/pelican`)
    ) ||
    /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value.split("?")[0])
  )
    return fallback;
  try {
    const url = new URL(value, "https://workspace.invalid");
    if (
      url.origin !== "https://workspace.invalid" ||
      !url.pathname.startsWith(`/${locale}/`) ||
      !(
        isWorkspacePath(url.pathname) ||
        /^\/(en|zh-CN)\/(?:open-prompts(?:\/|$)|pelican(?:\/manage)?\/?$)/.test(url.pathname)
      )
    )
      return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function loginDestination(path: string, locale: Locale, reason = "required") {
  return `/${locale}/login?${new URLSearchParams({ next: safeWorkspaceNext(path, locale), reason })}`;
}
