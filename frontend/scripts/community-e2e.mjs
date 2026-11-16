import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

// A completely disposable database keeps all test identities, licenses and Stars
// out of the developer's real immutable community history.
const original = new URL(process.env.DATABASE_URL ?? "invalid:");
if (
  !["localhost", "127.0.0.1"].includes(original.hostname) ||
  original.pathname !== "/promptmaster_dev"
)
  throw Error("LOCAL_DEVELOPMENT_DATABASE_REQUIRED");
const name = `pm_community_e2e_${randomBytes(8).toString("hex")}`;
if (!/^pm_community_e2e_[a-f0-9]{16}$/.test(name)) throw Error("UNSAFE_DATABASE_NAME");
const target = new URL(original);
target.pathname = `/${name}`;
const control = new Client({ connectionString: original.toString() });
const before = await Promise.all([
  readFile("next-env.d.ts", "utf8"),
  readFile("tsconfig.json", "utf8"),
]);
const evidence = path.join(
  process.env.LOCALAPPDATA ?? process.cwd(),
  "PromptMasterAI",
  "community-evidence",
);
await mkdir(evidence, { recursive: true });
const env = {
  ...process.env,
  DATABASE_URL: target.toString(),
  PROMPTMASTER_COMMUNITY_E2E: "true",
  PROMPTMASTER_COMMUNITY_E2E_DB: target.toString(),
  PROMPTMASTER_COMMUNITY_EVIDENCE: evidence,
  PROMPTMASTER_DEMO_API_ENABLED: "true",
  DEEPSEEK_API_KEY: "",
  SILICONFLOW_API_KEY: "",
};
let server;
let log = "";
await control.connect();
try {
  await control.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const migrate = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    env,
    stdio: "pipe",
    windowsHide: true,
  });
  if (migrate.status !== 0)
    throw Error(`DISPOSABLE_MIGRATION_FAILED: ${migrate.stderr.toString().slice(-2000)}`);
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--port", "3107", "--hostname", "127.0.0.1"],
    { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (value) => {
      log = (log + value.toString()).slice(-18000);
    });
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch("http://127.0.0.1:3107/api/community", {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for this isolated server. */
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (!ready) throw Error(`ISOLATED_SERVER_UNAVAILABLE: ${log}`);
  const result = await new Promise((resolve) => {
    const runner = spawn(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "playwright.community.config.ts",
      ],
      { env, stdio: "inherit", windowsHide: true },
    );
    runner.on("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = Number(result);
  console.log(`Community browser evidence: ${evidence}`);
} finally {
  if (server && server.exitCode === null) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else server.kill("SIGTERM");
  }
  await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await control.end();
  // Next adjusts its generated type references for the isolated distDir. Restore
  // only those test-specific edits, preserving unrelated concurrent source edits.
  const generated = await readFile("next-env.d.ts", "utf8");
  if (generated.includes(".next/community-e2e")) await writeFile("next-env.d.ts", before[0]);
  const config = JSON.parse(await readFile("tsconfig.json", "utf8"));
  if (config.include?.some((x) => x.includes(".next/community-e2e"))) {
    config.include = config.include.filter((x) => !x.includes(".next/community-e2e"));
    const previous = JSON.parse(before[1]);
    await writeFile(
      "tsconfig.json",
      JSON.stringify(config) === JSON.stringify(previous)
        ? before[1]
        : JSON.stringify(config, null, 2) + "\n",
    );
  }
}
