import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isFeaturedPublication, rankFeaturedCandidates } from "../src/lib/featured-skills.ts";
import { collectRepositoryStars } from "./lib/github-stars.mjs";

// Intentionally no publish/write mode. Review stdout, add a new release, then switch
// the server's static import in a separately reviewed local edit. Old releases remain.
if (process.argv.slice(2).join(" ") !== "--collect") {
  console.error(
    "Usage: node scripts/refresh-featured-skills.mjs --collect (three public metadata reads; prints an unpublished draft only)",
  );
  process.exitCode = 1;
} else {
  try {
    const file = new URL(
      "../src/lib/server/skills/catalog/featured-20261105-01.json",
      import.meta.url,
    );
    const current = JSON.parse(await readFile(fileURLToPath(file), "utf8"));
    if (!isFeaturedPublication(current)) throw new Error("INVALID_PUBLICATION");
    const observations = await collectRepositoryStars(current.repositories, current.observations);
    const publishedAt = new Date().toISOString();
    const draft = {
      ...current,
      id: `featured-draft-${publishedAt.replace(/[^0-9]/g, "")}`,
      publishedAt,
      observations,
      orderedEntryIds: rankFeaturedCandidates(
        current.repositories,
        current.candidates,
        observations,
      ),
    };
    if (!isFeaturedPublication(draft)) throw new Error("INVALID_DRAFT");
    console.log(JSON.stringify({ status: "UNPUBLISHED_DRAFT", publication: draft }, null, 2));
    if (observations.some((o) => o.lastAttempt.result === "FAILED")) process.exitCode = 2;
  } catch {
    console.error("Featured metadata collection failed; published data was not changed.");
    process.exitCode = 1;
  }
}
