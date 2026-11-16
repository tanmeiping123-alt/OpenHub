import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  CommunityAuthor,
  CommunityCard,
  CommunityCopySource,
  CommunityDetail,
  CommunityModeration,
  CommunityOrigin,
  CommunityPage,
  CommunityReportCategory,
  CommunitySeed,
  CommunityVersion,
  CommunityViewer,
  PublicationInput,
} from "@/lib/community-types";
import type { Actor } from "../identity-context";
import {
  canonicalSearch,
  legacyPurposes,
  searchSynonyms,
  type PromptDescriptor,
  type PurposeId,
} from "@/lib/prompt-description";
import { AccountError } from "../account-errors";
import { assertPromptCapacity } from "../billing/entitlements";
import {
  contentHash,
  fingerprint,
  identifier,
  listQuery,
  positive,
  requestKey,
  type ModerationInput,
  type ModerationPages,
} from "./validation";

const id = (prefix: string) => `${prefix}_${randomUUID()}`;
function creatorId(actor: Actor) {
  const h = contentHash(`open-prompt-community-creator-v1:${actor.id}`).slice(0, 32);
  return `creator_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const iso = (value: Date | string) => new Date(value).toISOString();
type PublicationRow = {
  id: string;
  creator_id: string;
  owner_user_id: string;
  status: CommunityCard["status"];
  current_version: number;
  removed_from_status: "PUBLISHED" | "WITHDRAWN" | null;
};
type VersionRow = {
  public_id: string;
  version_number: number;
  title: string;
  summary: string;
  task_type: CommunityCard["taskType"];
  language: CommunityCard["language"];
  tags: string[];
  purposes: PurposeId[] | null;
  content: string;
  variables: string;
  model_notes: string;
  example_input: string;
  example_output: string;
  usage_notes: string;
  change_note: string;
  content_hash: string;
  license: "CC0-1.0";
  created_at: Date;
  origin_public_id: string | null;
  origin_version: number | null;
  origin_title: string | null;
  origin_available: boolean;
};
type CardRow = VersionRow & {
  id: string;
  current_version: number;
  creator_id: string;
  display_name: string;
  bio: string;
  stars: number;
  recent_stars: number;
  first_published_at: Date;
  updated_at: Date;
  status: CommunityCard["status"];
};
const base = `FROM community_publications p
 JOIN community_creators a ON a.id=p.creator_id
 JOIN community_versions v ON v.public_id=p.id AND v.version_number=p.current_version`;
const countsSql = `LEFT JOIN LATERAL (SELECT count(*)::int AS stars,
 count(*) FILTER(WHERE first_starred_at>=now()-interval '7 days' AND first_starred_at<=now())::int AS recent_stars
 FROM community_stars WHERE public_id=p.id AND active AND NOT excluded) totals ON true`;
const selectCard = `SELECT p.id,p.current_version,p.creator_id,p.status,p.first_published_at,p.updated_at,a.display_name,a.bio,v.*,totals.stars,totals.recent_stars`;
function author(row: { creator_id: string; display_name: string; bio: string }): CommunityAuthor {
  return { id: row.creator_id, name: row.display_name, bio: row.bio };
}
function card(row: CardRow): CommunityCard {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    taskType: row.task_type,
    language: row.language,
    tags: row.tags,
    purposes: row.purposes ?? legacyPurposes(row.task_type),
    author: author(row),
    stars: row.stars,
    recentStars: row.recent_stars,
    versionNumber: row.version_number,
    firstPublishedAt: iso(row.first_published_at),
    updatedAt: iso(row.updated_at),
    status: row.status,
  };
}
function origin(row: VersionRow): CommunityOrigin | null {
  return row.origin_public_id
    ? {
        publicId: row.origin_public_id,
        versionNumber: row.origin_version!,
        title: row.origin_available === false ? "" : row.origin_title!,
        available: row.origin_available,
      }
    : null;
}
function version(row: VersionRow): CommunityVersion {
  return {
    number: row.version_number,
    content: row.content,
    variables: row.variables,
    modelNotes: row.model_notes,
    exampleInput: row.example_input,
    exampleOutput: row.example_output,
    usageNotes: row.usage_notes,
    changeNote: row.change_note,
    hash: row.content_hash,
    license: row.license,
    createdAt: iso(row.created_at),
    origin: origin(row),
  };
}
async function actorLock(c: PoolClient, actor: Actor) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`community-actor:${actor.id}`]);
}
async function creator(c: PoolClient, actor: Actor) {
  return (
    await c.query<{ id: string; display_name: string; bio: string }>(
      `INSERT INTO community_creators(id,owner_user_id) VALUES($1,$2)
   ON CONFLICT(owner_user_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id RETURNING id,display_name,bio`,
      [creatorId(actor), actor.id],
    )
  ).rows[0];
}
async function profile(c: PoolClient, actor: Actor, input: PublicationInput) {
  const a = await creator(c, actor);
  await c.query("UPDATE community_creators SET display_name=$2,bio=$3 WHERE id=$1", [
    a.id,
    input.authorName,
    input.authorBio,
  ]);
  return a.id;
}
async function locked(c: PoolClient, publicId: string): Promise<PublicationRow> {
  identifier(publicId, "pub");
  const p = (
    await c.query<PublicationRow>(
      `SELECT p.*,a.owner_user_id FROM community_publications p JOIN community_creators a ON a.id=p.creator_id WHERE p.id=$1 FOR UPDATE OF p`,
      [publicId],
    )
  ).rows[0];
  if (!p) throw new AccountError("PUBLICATION_NOT_FOUND", 404);
  return p;
}
function own(p: PublicationRow, actor: Actor) {
  if (p.owner_user_id !== actor.id) throw new AccountError("PUBLICATION_NOT_FOUND", 404);
}
function available(p: PublicationRow) {
  if (p.status !== "PUBLISHED") throw new AccountError("PUBLICATION_NOT_FOUND", 404);
}
function editable(p: PublicationRow, actor: Actor) {
  own(p, actor);
  if (p.status === "REMOVED") throw new AccountError("PUBLICATION_REMOVED", 409);
}
async function rate(c: PoolClient, actor: Actor, operation: string, max = 60, daily = false) {
  const r = await c.query<{ used: number }>(
    `INSERT INTO community_write_limits(actor_id,operation,bucket,used)
    VALUES($1,$2,CASE WHEN $3::boolean THEN date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' ELSE date_trunc('minute',now()) END,1)
    ON CONFLICT(actor_id,operation,bucket) DO UPDATE SET used=community_write_limits.used+1 RETURNING used`,
    [actor.id, operation, daily],
  );
  if (r.rows[0].used > max)
    throw new AccountError(daily ? "PUBLISH_DAILY_LIMIT" : "COMMUNITY_RATE_LIMIT", 429);
}
async function receipt<T>(
  c: PoolClient,
  actor: Actor,
  operation: string,
  key: string,
  payload: unknown,
  work: () => Promise<T>,
): Promise<T> {
  requestKey(key);
  const hash = fingerprint(payload);
  const previous = (
    await c.query<{ payload_hash: string; result: T }>(
      "SELECT payload_hash,result FROM community_receipts WHERE actor_id=$1 AND operation=$2 AND request_key=$3",
      [actor.id, operation, key],
    )
  ).rows[0];
  if (previous) {
    if (previous.payload_hash !== hash) throw new AccountError("IDEMPOTENCY_CONFLICT", 409);
    return previous.result;
  }
  const result = await work();
  await c.query(
    "INSERT INTO community_receipts(actor_id,operation,request_key,payload_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)",
    [actor.id, operation, key, hash, JSON.stringify(result)],
  );
  return result;
}
async function publicVersion(c: PoolClient, publicId: string, number: number) {
  const row = (
    await c.query<VersionRow>(
      "SELECT * FROM community_versions WHERE public_id=$1 AND version_number=$2",
      [publicId, number],
    )
  ).rows[0];
  if (!row) throw new AccountError("PUBLIC_VERSION_NOT_FOUND", 404);
  return row;
}
export async function list(
  c: PoolClient,
  params: URLSearchParams,
  actor?: Actor,
): Promise<CommunityPage> {
  const q = listQuery(params);
  const pageSize = 20;
  const values: unknown[] = [
    canonicalSearch(q.q).split(/\s+/).filter(Boolean),
    q.category,
    q.language,
    q.author,
    actor?.id ?? null,
    q.tab,
    q.purpose,
    canonicalSearch(q.tag),
  ];
  const addValue = (value: string) => {
    values.push(value);
    return `$${values.length}`;
  };
  // Build both query and corpus from the same maintained synonym table; all user values stay parameters.
  const canonicalSql = (expression: string) => {
    let sql = `regexp_replace(lower(normalize(${expression}, NFKC)),'[[:space:]]+',' ','g')`;
    for (const [alias, canonical] of searchSynonyms)
      sql = `replace(${sql},${addValue(alias)},${addValue(canonical)})`;
    return sql;
  };
  const search = `CROSS JOIN LATERAL (SELECT ${canonicalSql("v.title")} AS title,${canonicalSql("v.summary")} AS summary,${canonicalSql("array_to_string(v.tags,' ')")} AS tags,${canonicalSql("v.content")} AS content) search`;
  const legacySql = `CASE v.task_type WHEN 'Coding' THEN ARRAY['build'] WHEN 'UI/UX Design' THEN ARRAY['build'] WHEN 'Writing' THEN ARRAY['create'] WHEN 'Data Analysis' THEN ARRAY['analyze'] WHEN 'Business' THEN ARRAY['plan'] WHEN 'Research' THEN ARRAY['analyze'] WHEN 'AI Agent' THEN ARRAY['build'] ELSE ARRAY[]::text[] END`;
  const tagSql = canonicalSql("tag");
  const where = `WHERE ($5::text IS NOT NULL AND $6='published' AND a.owner_user_id=$5 OR p.status='PUBLISHED' AND ($5::text IS NULL OR $6='starred' AND EXISTS(SELECT 1 FROM community_stars s WHERE s.public_id=p.id AND s.actor_id=$5 AND s.active)))
    AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) term WHERE position(term in concat_ws(' ',search.title,search.summary,search.tags,search.content))=0)
    AND ($2='' OR v.task_type=$2) AND ($3='' OR v.language=$3) AND ($4='' OR p.creator_id=$4)
    AND ($7='' OR $7=ANY(COALESCE(p.purposes,${legacySql})))
    AND ($8='' OR EXISTS(SELECT 1 FROM unnest(v.tags) tag WHERE ${tagSql}=$8))`;
  const rank = `(SELECT COALESCE(sum(CASE WHEN position(term in search.title)>0 THEN 8 ELSE 0 END + CASE WHEN position(term in search.tags)>0 THEN 5 ELSE 0 END + CASE WHEN position(term in search.summary)>0 THEN 3 ELSE 0 END + CASE WHEN position(term in search.content)>0 THEN 1 ELSE 0 END),0) FROM unnest($1::text[]) term)`;
  const orders = {
    stars: "totals.stars DESC,p.first_published_at DESC,p.id ASC",
    recent: "totals.recent_stars DESC,totals.stars DESC,p.first_published_at DESC,p.id ASC",
    newest: "p.first_published_at DESC,p.id ASC",
    relevance: `${rank} DESC,totals.stars DESC,p.first_published_at DESC,p.id ASC`,
  };
  const r = await c.query<CardRow>(
    `${selectCard} ${base} ${countsSql} ${search} ${where} ORDER BY ${orders[q.sort]} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, (q.page - 1) * pageSize],
  );
  const total = (
    await c.query<{ total: number; as_of: Date }>(
      `SELECT count(*)::int AS total,now() AS as_of ${base} ${search} ${where}`,
      values,
    )
  ).rows[0];
  return {
    items: r.rows.map(card),
    total: total.total,
    page: q.page,
    pageSize,
    asOf: iso(total.as_of),
  };
}
async function readDetail(
  c: PoolClient,
  publicId: string,
  number?: number,
  owner?: Actor,
): Promise<CommunityDetail> {
  identifier(publicId, "pub");
  const row = (
    await c.query<CardRow>(
      `${selectCard},EXISTS(SELECT 1 FROM community_publications o WHERE o.id=v.origin_public_id AND o.status='PUBLISHED') AS origin_available
   FROM community_publications p JOIN community_creators a ON a.id=p.creator_id JOIN community_versions v ON v.public_id=p.id AND v.version_number=COALESCE($2::int,p.current_version)
   ${countsSql} WHERE p.id=$1 AND (p.status='PUBLISHED' AND $3::text IS NULL OR a.owner_user_id=$3) FOR SHARE OF p`,
      [publicId, number ?? null, owner?.id ?? null],
    )
  ).rows[0];
  if (!row) throw new AccountError("PUBLICATION_NOT_FOUND", 404);
  const history = await c.query<{ version_number: number; change_note: string; created_at: Date }>(
    "SELECT version_number,change_note,created_at FROM community_versions WHERE public_id=$1 ORDER BY version_number DESC",
    [publicId],
  );
  return {
    ...card(row),
    versionNumber: row.current_version,
    version: version(row),
    versions: history.rows.map((v) => ({
      number: v.version_number,
      changeNote: v.change_note,
      createdAt: iso(v.created_at),
    })),
  };
}
export const detail = (c: PoolClient, publicId: string, number?: number) =>
  readDetail(c, publicId, number);
export const ownedDetail = (c: PoolClient, actor: Actor, publicId: string) =>
  readDetail(c, publicId, undefined, actor);
export async function creatorProfile(c: PoolClient, creatorId: string): Promise<CommunityAuthor> {
  identifier(creatorId, "creator");
  const row = (
    await c.query<{ creator_id: string; display_name: string; bio: string }>(
      "SELECT id AS creator_id,display_name,bio FROM community_creators WHERE id=$1 AND display_name<>''",
      [creatorId],
    )
  ).rows[0];
  if (!row) throw new AccountError("CREATOR_NOT_FOUND", 404);
  return author(row);
}
export async function viewer(
  c: PoolClient,
  actor: Actor | null,
  publicId?: string,
): Promise<CommunityViewer> {
  if (!actor) return { user: null, isOwner: false, starred: false };
  if (publicId) identifier(publicId, "pub");
  const a = (
    await c.query<{ id: string; display_name: string; bio: string }>(
      "SELECT id,display_name,bio FROM community_creators WHERE owner_user_id=$1",
      [actor.id],
    )
  ).rows[0] ?? { id: creatorId(actor), display_name: "", bio: "" };
  const row = publicId
    ? (
        await c.query<{ is_owner: boolean; starred: boolean }>(
          `SELECT a.owner_user_id=$2 AS is_owner,
    EXISTS(SELECT 1 FROM community_stars s WHERE s.public_id=p.id AND s.actor_id=$2 AND s.active) AS starred
    FROM community_publications p JOIN community_creators a ON a.id=p.creator_id WHERE p.id=$1 AND (p.status='PUBLISHED' OR a.owner_user_id=$2)`,
          [publicId, actor.id],
        )
      ).rows[0]
    : null;
  return {
    user: { id: a.id, name: a.display_name, bio: a.bio, role: actor.role },
    isOwner: row?.is_owner ?? false,
    starred: row?.starred ?? false,
  };
}
export async function copySource(
  c: PoolClient,
  actor: Actor,
  promptId: string,
): Promise<CommunityCopySource | null> {
  identifier(promptId, "prm");
  const owned = await c.query("SELECT 1 FROM prompts WHERE id=$1 AND owner_user_id=$2", [
    promptId,
    actor.id,
  ]);
  if (!owned.rowCount) throw new AccountError("PROMPT_NOT_FOUND", 404);
  const r = (
    await c.query<{
      public_id: string;
      version_number: number;
      title: string;
      content_hash: string;
      license: "CC0-1.0";
      available: boolean;
    }>(
      `SELECT s.public_id,s.version_number,s.title,s.content_hash,s.license,p.status='PUBLISHED' AS available FROM community_copy_sources s JOIN community_publications p ON p.id=s.public_id WHERE s.prompt_id=$1 AND s.owner_user_id=$2`,
      [promptId, actor.id],
    )
  ).rows[0];
  return r
    ? {
        publicId: r.public_id,
        versionNumber: r.version_number,
        title: r.title,
        hash: r.content_hash,
        license: r.license,
        available: r.available,
      }
    : null;
}
export async function source(
  c: PoolClient,
  actor: Actor,
  versionId: string,
): Promise<CommunitySeed> {
  identifier(versionId, "ver");
  const row = (
    await c.query<{
      prompt_id: string;
      title: string;
      content: string;
      task_type: CommunitySeed["taskType"];
      descriptor: PromptDescriptor | null;
    }>(
      `SELECT v.prompt_id,v.title,v.content,p.task_type,p.descriptor FROM prompt_versions v JOIN prompts p ON p.id=v.prompt_id AND p.owner_user_id=v.owner_user_id WHERE v.id=$1 AND v.owner_user_id=$2`,
      [versionId, actor.id],
    )
  ).rows[0];
  if (!row) throw new AccountError("PROMPT_VERSION_NOT_FOUND", 404);
  const provenance = await copySource(c, actor, row.prompt_id);
  return {
    title: row.title,
    content: row.content,
    taskType: row.task_type,
    ...(row.descriptor !== null && row.descriptor !== undefined
      ? { descriptor: row.descriptor }
      : {}),
    sourceVersionId: versionId,
    origin: provenance
      ? {
          publicId: provenance.publicId,
          versionNumber: provenance.versionNumber,
          title: provenance.title,
          available: provenance.available,
        }
      : null,
  };
}
async function resolveOrigin(
  c: PoolClient,
  actor: Actor,
  input: PublicationInput,
  publicId?: string,
): Promise<CommunityOrigin | null> {
  let result: CommunityOrigin | null = null;
  if (input.sourceVersionId) {
    const seed = await source(c, actor, input.sourceVersionId);
    if (seed.content !== input.content) throw new AccountError("SOURCE_CONTENT_MISMATCH", 409);
    result = seed.origin;
  }
  if (input.sourcePublicId) {
    if (
      result &&
      (result.publicId !== input.sourcePublicId ||
        result.versionNumber !== input.sourcePublicVersion)
    )
      throw new AccountError("ORIGIN_MISMATCH", 409);
    if (!result) {
      const p = await locked(c, input.sourcePublicId);
      available(p);
      const v = await publicVersion(c, p.id, input.sourcePublicVersion!);
      result = { publicId: p.id, versionNumber: v.version_number, title: v.title, available: true };
    }
  }
  if (result && result.publicId !== publicId) {
    const v = await publicVersion(c, result.publicId, result.versionNumber);
    if (v.content_hash === contentHash(input.content))
      throw new AccountError("ALREADY_PUBLISHED", 409);
  }
  if (result?.publicId === publicId) result = null;
  return result;
}
async function duplicate(c: PoolClient, actor: Actor, hash: string, publicId?: string) {
  const same = await c.query(
    `SELECT 1 FROM community_publications p JOIN community_creators a ON a.id=p.creator_id JOIN community_versions v ON v.public_id=p.id
   WHERE a.owner_user_id=$1 AND v.content_hash=$2 AND ($3::text IS NULL OR p.id<>$3)
   UNION ALL SELECT 1 FROM community_copy_sources s WHERE s.owner_user_id=$1 AND s.content_hash=$2 AND ($3::text IS NULL OR s.public_id<>$3) LIMIT 1`,
    [actor.id, hash, publicId ?? null],
  );
  if (same.rowCount) throw new AccountError("ALREADY_PUBLISHED", 409);
}
async function addVersion(
  c: PoolClient,
  publicId: string,
  number: number,
  input: PublicationInput,
  provenance: CommunityOrigin | null,
) {
  if (!input.consent) throw new AccountError("CONSENT_REQUIRED");
  const consent = {
    license: "CC0-1.0",
    accepted: true,
    rightsConfirmed: true,
    publicScope: "prompt-and-submitted-annotations",
    statementVersion: "2026-11-06",
    acceptedAt: new Date().toISOString(),
  };
  await c.query(
    `INSERT INTO community_versions(public_id,version_number,title,summary,task_type,language,tags,content,variables,model_notes,example_input,example_output,usage_notes,change_note,content_hash,source_version_id,origin_public_id,origin_version,origin_title,consent_snapshot,purposes)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)`,
    [
      publicId,
      number,
      input.title,
      input.summary,
      input.taskType,
      input.language,
      input.tags,
      input.content,
      input.variables,
      input.modelNotes,
      input.exampleInput,
      input.exampleOutput,
      input.usageNotes,
      input.changeNote,
      contentHash(input.content),
      input.sourceVersionId ?? null,
      provenance?.publicId ?? null,
      provenance?.versionNumber ?? null,
      provenance?.title ?? null,
      JSON.stringify(consent),
      input.purposes ?? null,
    ],
  );
}
export async function publish(c: PoolClient, actor: Actor, input: PublicationInput, key: string) {
  await actorLock(c, actor);
  return receipt(c, actor, "publish", key, input, async () => {
    const provenance = await resolveOrigin(c, actor, input);
    await duplicate(c, actor, contentHash(input.content));
    const configured = Number(process.env.PROMPTMASTER_COMMUNITY_PUBLISH_DAILY_LIMIT ?? 20);
    const limit =
      Number.isSafeInteger(configured) && configured > 0 && configured <= 1000 ? configured : 20;
    await rate(c, actor, "publish", limit, true);
    const creatorId = await profile(c, actor, input);
    const publicId = id("pub");
    await c.query(
      `INSERT INTO community_publications(id,creator_id,current_version,consent_snapshot,purposes) VALUES($1,$2,1,$3::jsonb,$4)`,
      [
        publicId,
        creatorId,
        JSON.stringify({
          license: "CC0-1.0",
          accepted: true,
          rightsConfirmed: true,
          publicScope: "prompt-and-submitted-annotations",
          statementVersion: "2026-11-06",
          acceptedAt: new Date().toISOString(),
        }),
        input.purposes ?? null,
      ],
    );
    await addVersion(c, publicId, 1, input, provenance);
    return { publicId, versionNumber: 1 };
  });
}
export async function update(
  c: PoolClient,
  actor: Actor,
  publicId: string,
  input: PublicationInput,
  key: string,
) {
  await actorLock(c, actor);
  const p = await locked(c, publicId);
  editable(p, actor);
  return receipt(c, actor, `update:${publicId}`, key, input, async () => {
    if (p.current_version !== input.baseVersion) throw new AccountError("VERSION_CONFLICT", 409);
    let provenance = await resolveOrigin(c, actor, input, publicId);
    if (!provenance && !input.sourceVersionId && !input.sourcePublicId) {
      const previous = await publicVersion(c, publicId, p.current_version);
      provenance = origin(previous);
    }
    await duplicate(c, actor, contentHash(input.content), publicId);
    await rate(c, actor, "update", 30);
    await profile(c, actor, input);
    const next = p.current_version + 1;
    await addVersion(c, publicId, next, input, provenance);
    await c.query(
      "UPDATE community_publications SET current_version=$2,purposes=$3,status='PUBLISHED',updated_at=now() WHERE id=$1",
      [publicId, next, input.purposes ?? null],
    );
    return { publicId, versionNumber: next };
  });
}
export async function withdraw(c: PoolClient, actor: Actor, publicId: string) {
  await actorLock(c, actor);
  const p = await locked(c, publicId);
  editable(p, actor);
  if (p.status !== "WITHDRAWN") {
    await rate(c, actor, "withdraw", 30);
    await c.query(
      "UPDATE community_publications SET status='WITHDRAWN',updated_at=now() WHERE id=$1",
      [publicId],
    );
  }
  return { publicId, status: "WITHDRAWN" as const };
}
async function counts(c: PoolClient, publicId: string) {
  const row = (
    await c.query<{ stars: number; recent_stars: number }>(
      `SELECT count(*)::int AS stars,count(*) FILTER(WHERE first_starred_at>=now()-interval '7 days' AND first_starred_at<=now())::int AS recent_stars FROM community_stars WHERE public_id=$1 AND active AND NOT excluded`,
      [publicId],
    )
  ).rows[0];
  return { stars: row.stars, recentStars: row.recent_stars };
}
export async function star(
  c: PoolClient,
  actor: Actor,
  publicId: string,
  active: boolean,
  number: number,
) {
  await actorLock(c, actor);
  const p = await locked(c, publicId);
  available(p);
  await publicVersion(c, publicId, number);
  if (p.owner_user_id === actor.id) throw new AccountError("SELF_STAR_FORBIDDEN", 409);
  const existing = (
    await c.query<{ active: boolean }>(
      "SELECT active FROM community_stars WHERE public_id=$1 AND actor_id=$2",
      [publicId, actor.id],
    )
  ).rows[0];
  if (existing?.active !== active && (active || existing)) {
    await rate(c, actor, "star", 60);
    await c.query(
      `INSERT INTO community_stars(id,public_id,actor_id,active) VALUES($1,$2,$3,$4)
      ON CONFLICT(public_id,actor_id) DO UPDATE SET active=EXCLUDED.active,updated_at=now()`,
      [id("star"), publicId, actor.id, active],
    );
  }
  return { starred: active, ...(await counts(c, publicId)) };
}
export async function copy(
  c: PoolClient,
  actor: Actor,
  publicId: string,
  number: number,
  key: string,
) {
  identifier(publicId, "pub");
  await actorLock(c, actor);
  const result = await receipt(
    c,
    actor,
    `copy:${publicId}`,
    key,
    { versionNumber: number },
    async () => {
      const p = await locked(c, publicId);
      available(p);
      const v = await publicVersion(c, publicId, number);
      await rate(c, actor, "copy", 30);
      await assertPromptCapacity(c, actor.id);
      const promptId = id("prm");
      const versionId = id("ver");
      await c.query(
        "INSERT INTO prompts(id,owner_user_id,kind,title,task_type,description,current_version_id,descriptor) VALUES($1,$2,'PERSONAL_PROMPT',$3,$4,$5,$6,$7::jsonb)",
        [
          promptId,
          actor.id,
          v.title,
          v.task_type,
          v.summary,
          versionId,
          JSON.stringify({ purposes: v.purposes ?? legacyPurposes(v.task_type), tags: v.tags }),
        ],
      );
      await c.query(
        "INSERT INTO prompt_versions(id,prompt_id,owner_user_id,version_number,title,content,created_by,source) VALUES($1,$2,$3,1,$4,$5,$3,'COMMUNITY_COPY')",
        [versionId, promptId, actor.id, v.title, v.content],
      );
      await c.query(
        "INSERT INTO history_records(id,owner_user_id,prompt_id,prompt_version_id,source) VALUES($1,$2,$3,$4,'COMMUNITY_COPY')",
        [id("his"), actor.id, promptId, versionId],
      );
      await c.query("INSERT INTO library_items(owner_user_id,prompt_id) VALUES($1,$2)", [
        actor.id,
        promptId,
      ]);
      await c.query(
        "INSERT INTO community_copy_sources(prompt_id,owner_user_id,copied_version_id,public_id,version_number,title,content_hash,license) VALUES($1,$2,$3,$4,$5,$6,$7,'CC0-1.0')",
        [promptId, actor.id, versionId, publicId, number, v.title, v.content_hash],
      );
      return { promptId, versionId };
    },
  );
  // A successful receipt belongs to this actor; verify the private result before replay.
  const owned = await c.query(
    "SELECT 1 FROM prompt_versions WHERE id=$1 AND prompt_id=$2 AND owner_user_id=$3",
    [result.versionId, result.promptId, actor.id],
  );
  if (!owned.rowCount) throw new AccountError("PROMPT_NOT_FOUND", 404);
  return result;
}
export async function report(
  c: PoolClient,
  actor: Actor,
  publicId: string,
  input: { category: CommunityReportCategory; detail: string },
  key: string,
) {
  identifier(publicId, "pub");
  await actorLock(c, actor);
  return receipt(c, actor, `report:${publicId}`, key, input, async () => {
    const p = await locked(c, publicId);
    available(p);
    await rate(c, actor, "report", 10);
    const reportId = id("report");
    await c.query(
      "INSERT INTO community_reports(id,public_id,actor_id,category,detail) VALUES($1,$2,$3,$4,$5)",
      [reportId, publicId, actor.id, input.category, input.detail],
    );
    return { reportId };
  });
}
function admin(actor: Actor) {
  if (actor.role !== "ADMIN") throw new AccountError("ADMIN_REQUIRED", 403);
}
export async function moderation(
  c: PoolClient,
  actor: Actor,
  publicId?: string,
  pages: Partial<ModerationPages> = {},
): Promise<CommunityModeration> {
  admin(actor);
  if (publicId) identifier(publicId, "pub");
  const pageSize = 100;
  const reportsPage = positive(pages.reportsPage ?? 1);
  const starsPage = positive(pages.starsPage ?? 1);
  const eventsPage = positive(pages.eventsPage ?? 1);
  const reports = await c.query<{
    id: string;
    public_id: string;
    title: string;
    category: CommunityReportCategory;
    detail: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT r.id,r.public_id,v.title,r.category,r.detail,r.status,r.created_at FROM community_reports r JOIN community_publications p ON p.id=r.public_id JOIN community_versions v ON v.public_id=p.id AND v.version_number=p.current_version WHERE ($1::text IS NULL OR p.id=$1) ORDER BY (r.status='OPEN') DESC,r.created_at DESC,r.id DESC LIMIT 100 OFFSET $2`,
    [publicId ?? null, (reportsPage - 1) * pageSize],
  );
  const events = await c.query<{
    id: string;
    public_id: string | null;
    action: string;
    reason: string;
    created_at: Date;
  }>(
    "SELECT id,public_id,action,reason,created_at FROM community_events WHERE ($1::text IS NULL OR public_id=$1) ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET $2",
    [publicId ?? null, (eventsPage - 1) * pageSize],
  );
  const stars = publicId
    ? (
        await c.query<{
          id: string;
          public_id: string;
          active: boolean;
          excluded: boolean;
          first_starred_at: Date;
        }>(
          "SELECT id,public_id,active,excluded,first_starred_at FROM community_stars WHERE public_id=$1 ORDER BY first_starred_at DESC,id DESC LIMIT 100 OFFSET $2",
          [publicId, (starsPage - 1) * pageSize],
        )
      ).rows
    : [];
  const totals = (
    await c.query<{ reports: number; stars: number; events: number }>(
      `SELECT
      (SELECT count(*)::int FROM community_reports WHERE $1::text IS NULL OR public_id=$1) AS reports,
      (SELECT count(*)::int FROM community_events WHERE $1::text IS NULL OR public_id=$1) AS events,
      (SELECT count(*)::int FROM community_stars WHERE public_id=$1) AS stars`,
      [publicId ?? null],
    )
  ).rows[0];
  return {
    paging: {
      reports: { page: reportsPage, total: totals.reports, pageSize },
      stars: { page: starsPage, total: totals.stars, pageSize },
      events: { page: eventsPage, total: totals.events, pageSize },
    },
    reports: reports.rows.map((r) => ({
      id: r.id,
      publicId: r.public_id,
      title: r.title,
      category: r.category,
      detail: r.detail,
      status: r.status,
      createdAt: iso(r.created_at),
    })),
    events: events.rows.map((e) => ({
      id: e.id,
      publicId: e.public_id,
      action: e.action,
      reason: e.reason,
      createdAt: iso(e.created_at),
    })),
    stars: stars.map((s) => ({
      id: s.id,
      publicId: s.public_id,
      active: s.active,
      excluded: s.excluded,
      firstStarredAt: iso(s.first_starred_at),
    })),
  };
}
export async function moderate(c: PoolClient, actor: Actor, input: ModerationInput, key: string) {
  admin(actor);
  await actorLock(c, actor);
  return receipt(c, actor, "moderate", key, input, async () => {
    await rate(c, actor, "moderate", 60);
    let publicId = input.publicId;
    if (input.action === "remove" || input.action === "restore") {
      const p = await locked(c, publicId!);
      if (input.action === "remove" && p.status !== "REMOVED")
        await c.query(
          "UPDATE community_publications SET removed_from_status=status,status='REMOVED',updated_at=now() WHERE id=$1",
          [p.id],
        );
      if (input.action === "restore" && p.status === "REMOVED")
        await c.query(
          "UPDATE community_publications SET status=COALESCE(removed_from_status,'WITHDRAWN'),removed_from_status=NULL,updated_at=now() WHERE id=$1",
          [p.id],
        );
    } else if (input.action === "dismiss") {
      const r = (
        await c.query<{ public_id: string }>(
          "SELECT public_id FROM community_reports WHERE id=$1",
          [input.reportId],
        )
      ).rows[0];
      if (!r) throw new AccountError("REPORT_NOT_FOUND", 404);
      publicId = r.public_id;
      await locked(c, publicId);
      await c.query("UPDATE community_reports SET status='DISMISSED' WHERE id=$1", [
        input.reportId,
      ]);
    } else {
      const s = (
        await c.query<{ public_id: string }>("SELECT public_id FROM community_stars WHERE id=$1", [
          input.starId,
        ])
      ).rows[0];
      if (!s) throw new AccountError("STAR_NOT_FOUND", 404);
      publicId = s.public_id;
      await locked(c, publicId);
      await c.query("UPDATE community_stars SET excluded=$2,updated_at=now() WHERE id=$1", [
        input.starId,
        input.action === "excludeStar",
      ]);
    }
    const eventId = id("event");
    await c.query(
      "INSERT INTO community_events(id,public_id,actor_id,action,reason,report_id,star_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        eventId,
        publicId ?? null,
        actor.id,
        input.action,
        input.reason,
        input.reportId ?? null,
        input.starId ?? null,
      ],
    );
    return { eventId };
  });
}
