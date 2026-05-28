// Quick fix: regenerate batches that failed or were short in the clean dataset generation.
import * as fs from "node:fs";

function loadSettingsEnv() {
  const paths = [
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.json`,
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.local.json`,
  ];
  const env = { ...process.env };
  for (const p of paths) {
    try { const obj = JSON.parse(fs.readFileSync(p, "utf-8")); if (obj.env) Object.assign(env, obj.env); } catch {}
  }
  return env;
}

async function generate(prompt, retries = 3) {
  const env = loadSettingsEnv();
  const apiKey = env.DEEPSEEK_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  const baseURL = env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [
            { role: "system", content: "你是一个训练数据生成器。只输出纯JSON字符串数组。每条是一个中文对话片段。严格遵守JSON格式——字符串内的双引号必须转义为\\\"，不要用中文引号代替。不要markdown、不要解释、不要编号。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.9,
          max_tokens: 16384,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const content = data.choices?.[0]?.message?.content || "";

      // More robust JSON extraction: try multiple strategies
      let samples = null;
      // Strategy 1: bracket-depth-aware
      const start = content.indexOf("[");
      if (start !== -1) {
        let depth = 0;
        for (let i = start; i < content.length; i++) {
          if (content[i] === "[") depth++;
          else if (content[i] === "]") { depth--; if (depth === 0) { try { samples = JSON.parse(content.slice(start, i + 1)); } catch {} break; } }
        }
      }
      // Strategy 2: try parsing line by line
      if (!samples) {
        try { samples = JSON.parse(content); } catch {}
      }

      if (!samples || !Array.isArray(samples)) {
        console.error(`  No valid JSON array (attempt ${attempt + 1})`);
        fs.writeFileSync(`D:/Lingxi-v4/tools/gen-debug-${Date.now()}.txt`, content, "utf-8");
        continue;
      }
      return samples.filter(s => typeof s === "string" && s.length >= 8 && s.length <= 120);
    } catch (e) {
      console.error(`  Error (attempt ${attempt + 1}):`, e.message?.slice(0, 80));
    }
  }
  return [];
}

async function main() {
  const outPath = "D:/Lingxi-v4/tools/clean-training-dataset.jsonl";
  const existing = fs.readFileSync(outPath, "utf-8");
  const newLines = [];

  // ── WHERE: 250, in 2 batches of 125 to reduce JSON errors ──
  console.error("=== WHERE batch 1/2 (125) ===");
  const wherePrompt1 = `生成125条中文对话片段，每条涉及一个"位置/环境"信息。

场景类型（均匀分布）：
- 文件路径操作（不同OS风格：Windows D:/xxx/xxx.cs、Linux /home/xxx/config.yaml、Mac ~/xxx/xxx.tsx）
- 项目/模块/仓库引用（auth-service, game-engine, data-pipeline）
- 工具/平台名称（VSCode, Docker, GitHub Actions, AWS Lambda, Redis, PostgreSQL, Jenkins, Nginx）
- 版本号/里程碑（v2.3.1, 2026-Q2, sprint-14, RC3）
- 环境配置（.env, docker-compose.yml, k8s deployment, nginx.conf）

每条15-45字，自然融入对话语境。路径和环境信息是句子的有机部分。
输出纯JSON字符串数组。字符串内双引号必须转义为\\\"。`;
  try {
    const s = await generate(wherePrompt1);
    console.error(`  -> ${s.length} samples`);
    newLines.push(...s.map(t => JSON.stringify({ text: t, label: "WHERE" })));
  } catch (e) { console.error("  FAILED:", e.message?.slice(0, 60)); }

  console.error("=== WHERE batch 2/2 (125) ===");
  const wherePrompt2 = `生成125条中文对话片段，每条涉及位置/环境/工具信息。

均匀覆盖：
- 云服务路径（s3://bucket/key, gs://, azure blob）
- IDE和编辑器操作（"在VS Code里搜索" "用Vim打开"）
- 包管理器和依赖（npm/pip/cargo/maven/gradle）
- CI/CD流水线（GitLab CI, CircleCI, ArgoCD, TeamCity）
- 日志和监控工具（Prometheus, Grafana, ELK, Sentry, Datadog）
- 数据库和缓存（MySQL, MongoDB, Elasticsearch, Redis Cluster）

每条15-45字，自然融入对话。输出纯JSON字符串数组。`;
  try {
    const s = await generate(wherePrompt2);
    console.error(`  -> ${s.length} samples`);
    newLines.push(...s.map(t => JSON.stringify({ text: t, label: "WHERE" })));
  } catch (e) { console.error("  FAILED:", e.message?.slice(0, 60)); }

  // ── FEEL 技术型: 60 more ──
  console.error("=== FEEL 技术型 (60) ===");
  const feelTechPrompt = `生成60条中文对话片段，模拟一个用精确技术语言与AI编程助手协作的工程师。

特点：
- 纠正时引用具体方法名/参数/配置项/行号
- 认可时也像code review——"这个实现是对的""性能指标达标了"
- 催促时可以精确到具体模块/接口
- 语气冷静、就事论事，不带情绪化的口语词

每条15-60字，不要编号，不要前缀。输出纯JSON字符串数组。`;
  try {
    const s = await generate(feelTechPrompt);
    console.error(`  -> ${s.length} samples`);
    newLines.push(...s.map(t => JSON.stringify({ text: t, label: "FEEL" })));
  } catch (e) { console.error("  FAILED:", e.message?.slice(0, 60)); }

  // ── 嵌入式IoT WHAT: 40 more ──
  console.error("=== WHAT 嵌入式IoT (40) ===");
  const embeddedPrompt = `生成40条中文技术对话片段，嵌入式/IoT领域。

涉及：ARM交叉编译、RTOS任务调度、驱动开发、SPI/I2C/UART通信、MQTT协议、低功耗设计、BLE/WiFi、固件OTA、看门狗、DMA传输、中断处理、Flash磨损均衡

每条20-60字，具体的技术陈述或决策。不要编号，不要前缀。输出纯JSON字符串数组。`;
  try {
    const s = await generate(embeddedPrompt);
    console.error(`  -> ${s.length} samples`);
    newLines.push(...s.map(t => JSON.stringify({ text: t, label: "WHAT" })));
  } catch (e) { console.error("  FAILED:", e.message?.slice(0, 60)); }

  // ── Save ──
  if (newLines.length > 0) {
    const combined = existing.trim() + "\n" + newLines.join("\n") + "\n";
    fs.writeFileSync(outPath, combined, "utf-8");

    const allLines = combined.trim().split("\n").filter(Boolean);
    const byLabel = {};
    for (const l of allLines) {
      const o = JSON.parse(l);
      byLabel[o.label] = (byLabel[o.label] || 0) + 1;
    }
    console.error(`\n=== UPDATED ===`);
    console.error(`Total: ${allLines.length} samples`);
    console.error(`By channel:`, byLabel);
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
