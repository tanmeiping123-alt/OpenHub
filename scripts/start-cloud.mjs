import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateCloudEnvironment } from "./cloud-config.mjs";

validateCloudEnvironment(process.env);
const frontend = fileURLToPath(new URL("../frontend/", import.meta.url));
const migration = spawnSync(process.execPath, [path.join(frontend, "scripts/migrate.mjs")], {
  cwd: frontend, env: process.env, stdio: "inherit",
});
if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status ?? 1);

const server = spawn(process.execPath, [path.join(frontend, "node_modules/next/dist/bin/next"),
  "start", "--hostname", "0.0.0.0", "--port", process.env.PORT || "3000"], {
  cwd: frontend, env: process.env, stdio: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.kill(signal); });
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
server.on("exit", (code) => { process.exitCode = code ?? 1; });
