export type PromptChange = { kind: "same" | "added" | "removed"; text: string };

/** Bounded comparison: preserves every character, including whitespace and code. */
export function promptDiff(before: string, after: string): PromptChange[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];
  const tokenize = (text: string) =>
    text.match(/\r\n|[\r\n]|[^\S\r\n]+|[\u3400-\u9fff]|[^\s\u3400-\u9fff]+/gu) ?? [];
  const a = tokenize(before),
    b = tokenize(after);
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const old = a.slice(start, a.length - end),
    next = b.slice(start, b.length - end);
  const changes: PromptChange[] = [];
  const push = (kind: PromptChange["kind"], text: string) => {
    if (!text) return;
    const prior = changes.at(-1);
    if (prior?.kind === kind) prior.text += text;
    else changes.push({ kind, text });
  };
  push("same", a.slice(0, start).join(""));
  if (old.length * next.length > 250000) {
    push("removed", old.join(""));
    push("added", next.join(""));
  } else {
    const width = next.length + 1;
    const matrix = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--)
      for (let j = next.length - 1; j >= 0; j--)
        matrix[i * width + j] =
          old[i] === next[j]
            ? 1 + matrix[(i + 1) * width + j + 1]
            : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) {
        push("same", old[i++]);
        j++;
      } else if (
        i < old.length &&
        (j === next.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])
      )
        push("removed", old[i++]);
      else push("added", next[j++]);
    }
  }
  push("same", end ? a.slice(a.length - end).join("") : "");
  return changes;
}
