// Generate FEEL/WHAT boundary hard negatives for training
import * as fs from "fs";

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

async function main() {
  const env = loadSettingsEnv();
  const apiKey = env.DEEPSEEK_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  const baseURL = env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  if (!apiKey || apiKey.length < 10) { console.error("No API key"); process.exit(1); }

  // Type A: Looks like WHAT, is actually FEEL (100 samples)
  const typeAExamples = [
    "任何代码修改前必须先讨论确认全部细节，得到明确许可后才能动手",  // 表面规则，实质关系调节
    "铁律：讨论结果第一时间写入设计文档不等批量处理",
    "执行任何操作前必须问清所有细节，得到允许后才能执行",
    "用户表示不懂代码，拒绝做技术决策，要求直接处理",
    "你别再自己编配置了，每次都是读都不读就写一堆有的没的",
    "好吧，你承认没看懂就好，我再解释一遍，比装懂强",
    "你又在假装自己有一个真实的名字和人类身份",
    "你刚才给的方案不考虑一下我们在用的 PHP 5.6 版本吗",
    "你先不要做，等我说开始再开始",
    "你的简化方案删掉了我特意留下的注释",
  ];

  // Type B: Looks like FEEL, is actually WHAT (100 samples)
  const typeBExamples = [
    "用户要求使用Redis缓存替代本地存储以提升性能",  // 表面像偏好/纠正，实质是技术决策
    "用户希望UI设计改为深色主题并支持用户自定义配色",
    "项目决定采用React 18的并发特性来优化渲染性能",
    "用户选择方案B：使用WebSocket替代轮询来实现实时更新",
    "数据库从MySQL迁移到PostgreSQL以支持更复杂的查询",
    "用户要求所有API接口必须支持中英文双语返回",
    "技术选型确定为Next.js 14 + TypeScript + Prisma",
    "用户希望增加导出PDF和水印功能以满足合规要求",
    "设计方案最终确定：三级缓存架构，Redis→本地→CDN",
  ];

  const allResults = [];

  async function callLLM(systemPrompt, userPrompt) {
    const res = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.9,
        max_tokens: 16384,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content || "";
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array");
    return JSON.parse(match[0]);
  }

  // Batch 1: Type A (looks like WHAT, is FEEL) - 50 samples
  console.error("Generating Type A batch 1 (looks-like-WHAT is-FEEL)...");
  const typeA1 = await callLLM(
    "你输出纯JSON字符串数组。不要markdown，不要解释。",
    `生成50条中文FEEL通道边界样本。这些样本的特征是：表面读起来像在陈述规则、提技术需求、做决策（容易误判为WHAT通道），但实质是在纠正AI行为、划定与AI的边界、表达不满或无奈（真实标签应为FEEL）。

真实参考：
${typeAExamples.map((e,i) => (i+1)+'. '+e).join('\n')}

要求：
- 每条15-60字
- 表面必须像规则/决策（使用"必须""不要""禁止""方案""改为""要求"等词）
- 实质上是在调节与AI的关系（纠正、表达不满、划边界、防止AI越界）
- 自然口语化，有人味
- 输出纯JSON数组`
  );
  typeA1.forEach(text => allResults.push({ text, label: "FEEL" }));
  console.error(`  Got ${typeA1.length} samples`);

  // Batch 2: Type A - 50 more
  console.error("Generating Type A batch 2...");
  const typeA2 = await callLLM(
    "你输出纯JSON字符串数组。不要markdown，不要解释。",
    `再生成50条。更要多样化场景：代码修改、UI设计、文案写作、部署发布、数据库操作、文件管理、沟通方式、项目管理。

要求同前：表面像规则/决策，实质是关系调节。输出纯JSON数组。`
  );
  typeA2.forEach(text => allResults.push({ text, label: "FEEL" }));
  console.error(`  Got ${typeA2.length} samples`);

  // Type B: Looks like FEEL, is WHAT - 100 samples
  console.error("Generating Type B (looks-like-FEEL is-WHAT)...");
  const typeB = await callLLM(
    "你输出纯JSON字符串数组。不要markdown，不要解释。",
    `生成100条中文边界样本。这些样本的特征是：表面读起来像在表达偏好、纠正行为、情绪反馈（容易误判为FEEL通道），但实质上是在做技术决策、方案选择、需求确认（真实标签应为WHAT）。

真实参考：
${typeBExamples.map((e,i) => (i+1)+'. '+e).join('\n')}

要求：
- 每条15-60字
- 表面像偏好/纠正（使用"希望""要求""选择""决定"等词，像在对AI表达感受）
- 实质上是在做技术决策、方案选型、需求定义（应该是WHAT）
- 输出纯JSON数组`
  );
  typeB.forEach(text => allResults.push({ text, label: "WHAT" }));
  console.error(`  Got ${typeB.length} samples`);

  // Save
  const outPath = "./tools/boundary-samples.json";
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2), "utf-8");
  const dist = {};
  allResults.forEach(x => dist[x.label] = (dist[x.label] || 0) + 1);
  console.error(`\nTotal boundary samples: ${allResults.length}`, JSON.stringify(dist));
  console.error(`Saved to ${outPath}`);

  // Append to training dataset
  const trainPath = "./tools/feel-training-dataset.jsonl";
  const existing = fs.readFileSync(trainPath, "utf-8").split("\n").filter(Boolean);
  const newLines = allResults.map(x => JSON.stringify(x));
  const merged = [...existing, ...newLines];
  // Shuffle
  for (let i = merged.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [merged[i], merged[j]] = [merged[j], merged[i]];
  }
  fs.writeFileSync(trainPath, merged.join("\n") + "\n", "utf-8");
  console.error(`Training set updated: ${existing.length} -> ${merged.length} samples`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
