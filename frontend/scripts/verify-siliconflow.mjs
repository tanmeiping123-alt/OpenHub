// Read-only provider discovery. Never sends chat/completions or prints credentials.
const models = [
  "zai-org/GLM-5.3-Flash",
  "tencent/Hy4-preview",
  "zai-org/GLM-5.3",
  "deepseek-ai/DeepSeek-V4-Pro",
];
if (process.argv.includes("--docs")) {
  for (const url of [
    "https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions",
    "https://docs.siliconflow.cn/sitemap.xml",
    "https://siliconflow.cn/pricing",
    "https://cloud.siliconflow.cn/models",
  ]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const raw = await r.text();
      const t = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      console.log("SOURCE", url, r.status);
      if (url.includes("chat-completions")) {
        for (const term of ["reasoning_effort", "thinking_budget", "enable_thinking"]) {
          const i = t.indexOf(term);
          console.log(t.slice(Math.max(0, i - 50), i + 1500));
        }
      } else if (url.includes("sitemap")) console.log(raw.slice(0, 5000));
      else {
        console.log(t.slice(0, 800));
        console.log(
          [...raw.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)].map((m) => m[1]).slice(-15),
        );
      }
    } catch {
      console.log("DOC_UNREACHABLE", url);
    }
  }
} else {
  if (!process.env.SILICONFLOW_API_KEY)
    throw new Error("SILICONFLOW_API_KEY is required in the server environment.");
  try {
    const r = await fetch("https://api.siliconflow.cn/v1/models", {
      headers: { Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      console.log(JSON.stringify({ status: r.status }));
      process.exitCode = 1;
    } else {
      const j = await r.json();
      console.log(
        JSON.stringify({
          checkedAt: new Date().toISOString(),
          status: r.status,
          models: models.map((id) => ({ id, listed: j.data?.some((m) => m.id === id) })),
        }),
      );
    }
  } catch {
    console.log("MODEL_LIST_UNREACHABLE");
    process.exitCode = 1;
  }
}
