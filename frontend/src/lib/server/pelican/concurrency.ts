export const PELICAN_DEFAULT_CONCURRENCY = 3;
export const PELICAN_MAX_CONCURRENCY = 5;

/**
 * Reads the per-batch worker limit. Invalid values fall back to the default so a
 * mistyped environment variable cannot disable dispatch or spawn an unbounded pool.
 */
export function pelicanConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PROMPTMASTER_PELICAN_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return PELICAN_DEFAULT_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return PELICAN_DEFAULT_CONCURRENCY;
  return Math.min(PELICAN_MAX_CONCURRENCY, Math.max(1, parsed));
}

/**
 * Runs `worker` over the items with at most `limit` workers in flight. Each worker
 * pulls the next item when it finishes, so a slow model does not block the rest
 * beyond the concurrency ceiling. Results are intentionally not collected; callers
 * persist per-item outcomes themselves.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Concurrency limit must be a positive integer.");
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}
