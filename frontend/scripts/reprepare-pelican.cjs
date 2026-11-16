// One-off maintenance: re-derive previews for already-succeeded Pelican samples using the
// CURRENT renderer (remote-clock-v3). It transpiles renderer.ts in-process (the app's own
// TypeScript, not a reimplementation) and writes an immutable preview revision per sample.
// Raw output is never modified.
//
// Usage (from frontend/):
//   node --env-file-if-exists=.env.local scripts/reprepare-pelican.cjs           # apply
//   node --env-file-if-exists=.env.local scripts/reprepare-pelican.cjs --dry-run # list only
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ts = require("typescript");
const { Client } = require("pg");

const DRY = process.argv.includes("--dry-run");
const SILICONFLOW_MODELS = [
  "zai-org/GLM-5.3-Flash",
  "tencent/Hy4-preview",
  "zai-org/GLM-5.3",
  "deepseek-ai/DeepSeek-V4-Pro",
];

function loadRenderer() {
  const srcPath = path.join(__dirname, "..", "src", "lib", "server", "pelican", "renderer.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      isolatedModules: true,
    },
  }).outputText;
  const tmp = path.join(__dirname, ".renderer.cjs");
  fs.writeFileSync(tmp, output);
  const renderer = require(tmp);
  fs.unlinkSync(tmp);
  return renderer;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  const renderer = loadRenderer();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const admin = await client.query(
      "SELECT user_id FROM administrator_users WHERE NOT disabled ORDER BY user_id LIMIT 1",
    );
    if (!admin.rowCount) throw new Error("No active administrator_users row; cannot write revisions.");
    const createdBy = admin.rows[0].user_id;

    const { rows } = await client.query(
      `SELECT s.id, s.raw_output, s.response_finish_reason, s.preview_status, s.adapter_version, s.model_name
         FROM pelican_samples s
         JOIN pelican_batches b ON b.id = s.batch_id
         JOIN model_executions m ON m.id = s.execution_id
        WHERE m.status = 'SUCCEEDED'
          AND s.raw_output IS NOT NULL
          AND s.adapter_version IS NOT NULL
          AND s.adapter_version <> $1
          AND s.response_finish_reason IS DISTINCT FROM 'length'
          AND s.model_key = ANY($2::text[])
        ORDER BY s.created_at`,
      [renderer.PELICAN_ADAPTER_VERSION, SILICONFLOW_MODELS],
    );

    console.log(`Found ${rows.length} candidate sample(s).${DRY ? " [dry-run]" : ""}`);
    let updated = 0;
    for (const row of rows) {
      let preview;
      try {
        preview = await renderer.preparePelicanPreview(row.raw_output, row.response_finish_reason ?? undefined);
      } catch (error) {
        console.log(`SKIP ${row.model_name} ${row.id}: render threw ${error.message}`);
        continue;
      }
      const ok = preview.status === "READY" || preview.status === "STATIC";
      if (!ok || !preview.html || !preview.thumbnail) {
        console.log(`SKIP ${row.model_name} ${row.id}: ${preview.status} ${preview.reason ?? ""}`);
        continue;
      }
      if (DRY) {
        console.log(`WOULD UPDATE ${row.model_name} ${row.id}: ${row.preview_status} -> ${preview.status}`);
        updated++;
        continue;
      }
      const res = await client.query(
        `INSERT INTO pelican_preview_revisions(sample_id,adapter_version,raw_sha256,preview_html,preview_status,preview_reason,thumbnail,created_by)
         VALUES($1,$2,$3,$4,$5,NULL,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          row.id,
          preview.adapterVersion,
          sha256(row.raw_output),
          preview.html,
          preview.status,
          preview.thumbnail,
          createdBy,
        ],
      );
      if (res.rowCount) {
        updated++;
        console.log(`UPDATED ${row.model_name} ${row.id}: ${row.preview_status} -> ${preview.status}`);
      } else {
        console.log(`UNCHANGED ${row.model_name} ${row.id}: ${row.preview_status}`);
      }
    }
    console.log(`Done. ${updated} sample(s) ${DRY ? "would be" : "were"} updated.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
