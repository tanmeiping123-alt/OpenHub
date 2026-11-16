import { copyFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend");
const npmCli = process.env.npm_execpath;
if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error("Node.js 22 or newer is required; .nvmrc records the verified version.");
}
if (!npmCli) throw new Error("Run setup with npm run setup from the repository root.");
const options = new Set(process.argv.slice(2));
if ([...options].some((option) => option !== "--skip-browser")) {
  throw new Error("Supported option: --skip-browser (when matching Chromium is already installed).");
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, HUSKY: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Install the pinned Yarn CLI locally, without requiring a global Yarn/Corepack.
run(npmCli, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
run(npmCli, ["ci", "--no-audit", "--no-fund"], frontend);
run(
  path.join(root, "node_modules", "yarn", "bin", "yarn.js"),
  ["install", "--frozen-lockfile", "--non-interactive", "--ignore-scripts"],
  path.join(root, "modules", "excalidraw"),
);
try {
  await access(path.join(frontend, ".env.local"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await copyFile(path.join(frontend, ".env.example"), path.join(frontend, ".env.local"));
  console.log("Created frontend/.env.local from the safe template; configure local credentials.");
}
if (!options.has("--skip-browser")) {
  run(path.join(frontend, "node_modules", "playwright", "cli.js"), ["install", "chromium"], frontend);
}
run(path.join(root, "scripts", "build-whiteboard.mjs"), [], root);
console.log("Setup complete. Configure PostgreSQL and frontend/.env.local, then run npm run db:migrate and npm run dev.");
console.log("The existing local API guard disables business APIs under npm start (production mode).");
