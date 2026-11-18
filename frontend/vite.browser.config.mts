import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, rm } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const root = dirname(fileURLToPath(import.meta.url));
const navigation = resolve(root, "cloudflare/browser-navigation.tsx");
export default defineConfig({
  root: resolve(root, "cloudflare"), envDir: false, publicDir: resolve(root, "public"),
  resolve: { alias: [{ find: /^next\/link$/, replacement: navigation }, { find: /^next\/navigation$/, replacement: navigation }, { find: "@", replacement: resolve(root, "src") }] },
  define: { "process.env.NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED": JSON.stringify("true"), "process.env.NEXT_PUBLIC_OPENHUB_CLOUD_AUTH": JSON.stringify("true") },
  plugins: [tailwindcss(), react(), {
    name: "openhub-static-assets-deployment",
    async closeBundle() {
      // Personal payment assets stay local even when present in public/.
      await rm(resolve(root, "dist/client/payments"), { recursive: true, force: true });
      // The API-only Vite build omits assets because its client environment is
      // built separately. Attach the completed browser output before deployment.
      const path = resolve(root, "dist/ssr/wrangler.json");
      const worker = JSON.parse(await readFile(path, "utf8"));
      const source = JSON.parse(await readFile(resolve(root, "../wrangler.jsonc"), "utf8"));
      worker.assets = { ...source.assets, directory: "../client" };
      await writeFile(path, JSON.stringify(worker));
    },
  }],
  build: { outDir: resolve(root, "dist/client"), emptyOutDir: true },
});
