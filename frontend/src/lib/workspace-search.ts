import { localizedContentFor, localizedTaskType, localizedTitleFor } from "./fixtures";
import type { AppState, Locale, Prompt, PromptVersion } from "./types";
import { promptDiscoveryTerms } from "./prompt-description";

export function normalizeSearch(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// One edit (including adjacent transposition), only for Latin words of 4+ letters.
function nearWord(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i === a.length) return b.length - i <= 1;
  if (a.length === b.length)
    return (
      a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
    );
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function fuzzyScore(query: string, fields: string[]): number | null {
  const normalized = normalizeSearch(query.slice(0, 120));
  if (!normalized) return 0;
  const terms = normalized.split(/\s+/);
  const texts = fields.map(normalizeSearch);
  let score = 0;
  for (const term of terms) {
    const exact = texts.findIndex((text) => text.includes(term));
    if (exact !== -1) {
      score += Math.max(10, 80 - exact * 15);
      continue;
    }
    if (!/^[a-z]{4,30}$/.test(term)) return null;
    const approximate = texts.findIndex((text) =>
      (text.match(/[a-z]{3,31}/g) ?? []).some((word) => nearWord(term, word)),
    );
    if (approximate === -1) return null;
    score += Math.max(1, 20 - approximate * 4);
  }
  if (texts[0]?.includes(normalized)) score += 100;
  return score;
}

export type SearchDocument = {
  prompt: Prompt;
  version: PromptVersion;
  title: string;
  content: string;
  fields: string[];
  current: boolean;
};

export function buildSearchDocuments(
  state: Pick<AppState, "prompts" | "versions">,
  locale: Locale,
): SearchDocument[] {
  const prompts = new Map(state.prompts.map((prompt) => [prompt.id, prompt]));
  return state.versions.flatMap((version) => {
    const prompt = prompts.get(version.promptId);
    if (!prompt) return [];
    const current = version.id === prompt.currentVersionId;
    const title = localizedTitleFor(prompt.id, locale, current ? prompt.title : version.title);
    const content = localizedContentFor(version.id, locale, version.content);
    return [
      {
        prompt,
        version,
        title,
        content,
        current,
        fields: [
          title,
          current ? prompt.description : "",
          content,
          ...promptDiscoveryTerms(prompt),
          ...(prompt.descriptor === undefined
            ? [localizedTaskType(prompt.taskType, locale), prompt.taskType]
            : []),
          version.title,
          version.content,
        ],
      },
    ];
  });
}

export function searchDocuments(documents: SearchDocument[], query: string, limit = 12) {
  const empty = !normalizeSearch(query);
  const ranked = documents
    .flatMap((document) => {
      if (empty && !document.current) return [];
      const score = fuzzyScore(query, document.fields);
      return score === null ? [] : [{ ...document, score }];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.current) - Number(a.current) ||
        b.version.createdAt.localeCompare(a.version.createdAt) ||
        a.version.id.localeCompare(b.version.id),
    );
  return { total: ranked.length, items: ranked.slice(0, Math.max(0, limit)) };
}

export function searchSnippet(content: string, query: string) {
  const term = query
    .trim()
    .split(/\s+/)
    .find((word) => content.toLocaleLowerCase().includes(word.toLocaleLowerCase()));
  const start = term
    ? Math.max(0, content.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) - 28)
    : 0;
  const snippet = content.slice(start, start + 140).replace(/\s+/g, " ");
  return `${start ? "…" : ""}${snippet}${start + 140 < content.length ? "…" : ""}`;
}
