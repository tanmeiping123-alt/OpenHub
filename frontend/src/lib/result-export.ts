/** A conservative plain-text projection; fenced code is kept verbatim. */
export function resultPlainText(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length))) {
        fence = fence ? null : marker[1];
        return null;
      }
      if (fence) return line;
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
        .replace(/(`+)(.*?)\1/g, "$2")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/\*([^*\n]+)\*/g, "$1")
        .replace(/~~(.+?)~~/g, "$1");
    })
    .filter((line) => line !== null)
    .join("\n");
}

export function resultFilename(title: string, format: "md" | "txt"): string {
  const safe =
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 80) || "prompt-result";
  // Prefix also avoids Windows reserved device names such as CON and AUX.
  return `PromptMaster-${safe}.${format}`;
}
