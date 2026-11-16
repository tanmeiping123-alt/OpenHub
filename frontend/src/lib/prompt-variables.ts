// Only the explicit {{name}} convention is interactive. Mask Markdown code so
// examples and object syntax are never interpreted as a request for user data.
function variableTokens(content: string) {
  const visible = content.replace(
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(`+)[\s\S]*?\1/g,
    (code) => " ".repeat(code.length),
  );
  return Array.from(visible.matchAll(/(?<![{$])\{\{([\p{L}_][\p{L}\p{N}_-]{0,63})\}\}(?!\})/gu));
}

export function promptVariables(content: string): string[] {
  return [...new Set(variableTokens(content).map((token) => token[1]))];
}

export function fillPromptVariables(content: string, values: Record<string, string>): string {
  let result = "",
    offset = 0;
  for (const token of variableTokens(content)) {
    const index = token.index!;
    const value = Object.hasOwn(values, token[1]) ? values[token[1]] : "";
    result += content.slice(offset, index) + (value || token[0]);
    offset = index + token[0].length;
  }
  return result + content.slice(offset);
}
