import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(project, "modules", "excalidraw");
const app = path.join(source, "excalidraw-app");
const output = path.join(
  project,
  "frontend",
  "public",
  "modules",
  "excalidraw",
);
const preload =
  process.platform === "win32"
    ? ["--require", path.join(project, "scripts", "esbuild-windows-pipe.cjs")]
    : [];
const result = spawnSync(
  process.execPath,
  [
    ...preload,
    path.join(source, "node_modules", "vite", "bin", "vite.js"),
    "build",
  ],
  {
    cwd: app,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_APP_BASE_PATH: "/modules/excalidraw/",
      VITE_APP_EMBEDDED: "true",
      VITE_APP_DISABLE_SENTRY: "true",
      VITE_APP_ENABLE_TRACKING: "false",
      VITE_APP_ENABLE_ESLINT: "false",
    },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
// Only this module's generated directory is replaced, after a successful build.
const expectedOutput = path.resolve(project, "frontend/public/modules/excalidraw");
if (path.resolve(output) !== expectedOutput) throw new Error("Unexpected whiteboard output directory.");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(app, "build"), output, { recursive: true });
await cp(
  path.join(source, "packages", "excalidraw", "fonts", "Assistant"),
  path.join(output, "fonts", "Assistant"),
  { recursive: true },
);
await cp(path.join(source, "LICENSE"), path.join(output, "LICENSE.txt"));
const html = await readFile(path.join(output, "index.html"), "utf8");
if (!html.includes('src="/modules/excalidraw/assets/'))
  throw new Error("Whiteboard assets must stay inside its module.");
await writeFile(
  path.join(output, "integration.json"),
  JSON.stringify(
    {
      module: "Excalidraw",
      base: "/modules/excalidraw/",
      source: "modules/excalidraw",
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Whiteboard published to ${output}`);
