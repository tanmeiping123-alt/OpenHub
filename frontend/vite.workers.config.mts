import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";

const root = dirname(fileURLToPath(import.meta.url));
const server = resolve(root, "src/lib/server").replaceAll("\\", "/");
export default defineConfig({
  // Local .env files contain real operator credentials. Never load them into edge builds.
  envDir: false,
  define: {
    "process.env.NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED": JSON.stringify("true"),
    "process.env.NEXT_PUBLIC_OPENHUB_CLOUD_AUTH": JSON.stringify("true"),
  },
  publicDir: false,
  resolve: { alias: [{ find: /^next\/server$/, replacement: resolve(root, "cloudflare/next-response.ts") }, { find: /^server-only$/, replacement: resolve(root, "cloudflare/server-only.ts") }, { find: "@", replacement: resolve(root, "src") }] },
  plugins: [
    {
      name: "openhub-workers-server-adapters", enforce: "pre",
      // Framework path aliases can resolve before a custom resolveId hook. Replace
      // the loaded module so every import form shares the same Worker adapter.
      load(id) {
        const absolute = id.split("?")[0].replaceAll("\\", "/");
        if (absolute === `${server}/db.ts`) return `export * from ${JSON.stringify(`${server}/db-workers.ts`)};`;
        if (absolute === `${server}/pelican/renderer.ts`) return `export * from ${JSON.stringify(`${server}/pelican/renderer-workers.ts`)};`;
      },
    },
    cloudflare({ configPath: resolve(root, "../wrangler.jsonc"), viteEnvironment: { name: "ssr" } }),
  ],
});
