// Generate missing test samples: 45 FEEL boundary + 75 WHERE + 75 WHO
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

async function generateBatch(apiKey, baseURL, systemPrompt, userPrompt, count, label) {
  const res = await fetch(`${baseURL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 16384,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const content = data.choices?.[0]?.message?.content || "";
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("No JSON array: " + content.slice(0, 300));
  const samples = JSON.parse(match[0]);
  console.error(`  ${label}: generated ${samples.length} samples`);
  return samples.map(text => ({ text, label }));
}

async function main() {
  const env = loadSettingsEnv();
  const apiKey = env.DEEPSEEK_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  const baseURL = env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  if (!apiKey || apiKey.length < 10) { console.error("No API key"); process.exit(1); }

  const allResults = [];

  // 1. WHERE samples (75) - file paths, project names, tools
  const whereRefs = [
    "项目已编译完成，但 ANTHROPIC_API_KEY 未设置",
    "v2.0暂停中，代码6ee8cf4仅完成架构提交",
    "错误发生在 Phase3/index.tsx 第61行",
    "会话文件存储在 .claude/projects/ 目录下",
    "编导工具项目位于 Documents/short-video-agent/ 目录下",
    "Agent记忆设计文档副本存放于D:/AgentMemory/design-docs/",
    "扫描发现40个记忆文件（39个.md+1个CLAUDE.md）",
  ];
  console.error("Generating WHERE...");
  const where = await generateBatch(apiKey, baseURL,
    "你输出纯JSON字符串数组。不要markdown，不要解释。",
    `生成75条中文WHERE通道测试样本。WHERE通道定义：涉及文件路径、项目名称、工具名称、版本号、目录位置、代码位置、配置文件等技术定位信息。

真实参考：
${whereRefs.map((r,i) => (i+1)+'. '+r).join('\n')}

要求：
- 每条15-60字
- 自然对话语气，不需要固定句式
- 覆盖：文件路径、Git分支/commit、版本号、配置变量、工具名、目录、错误位置、API端点、数据库表名、端口号等
- 输出纯JSON数组`);

  allResults.push(...where);

  // 2. WHO samples (75) - people, roles, platforms
  const whoRefs = [
    "用户自述不是专业技术工程师，是普通AI用户",
    "用户是短视频编导，正在构建AI桌面应用",
    "用户是游戏开发者，主要使用Godot引擎",
    "用户人设为非程序员背景，闪光点是创意和执行力",
    "GPT负责代码审查，Opus参与方案设计",
    "用户自称'不懂代码的人'，无法做技术判断",
    "用户增加协作规则：在得到明确允许之前不要动手操作",
  ];
  console.error("Generating WHO...");
  const who = await generateBatch(apiKey, baseURL,
    "你输出纯JSON字符串数组。不要markdown，不要解释。",
    `生成75条中文WHO通道测试样本。WHO通道定义：涉及人物身份、角色定位、技能描述、协作关系、用户特征、工具归属、作者信息等。

真实参考：
${whoRefs.map((r,i) => (i+1)+'. '+r).join('\n')}

要求：
- 每条15-60字
- 自然对话语气
- 覆盖：用户身份、角色分工、技能水平、协作偏好、AI工具归属、作者信息、团队关系等
- 输出纯JSON数组`);

  allResults.push(...who);

  // 3. FEEL boundary samples (45) - surface like WHAT, actually FEEL
  const feelBoundaryRefs = [
    "任何代码修改前必须先讨论确认全部细节，得到明确许可后才能动手",
    "铁律：讨论结果第一时间写入设计文档不等批量处理",
    "执行任何操作前必须问清所有细节，得到允许后才能执行",
    "当存在更好方式或用户方案有问题时，必须直接指出不绕弯子",
    "大工作量任务启动前必须先征询用户同意",
    "用户表示不懂代码，拒绝做技术决策，要求直接处理",
    "用户纠正：Agent动手前必须先问清所有细节等待明确许可，不得擅自执行",
    "用户指出Agent把时间线串成好看故事来迎合情感氛围",
    "你别再自己编配置了，每次都是读都不读就写一堆有的没的",
  ];
  console.error("Generating FEEL boundary...");
  const feel = await generateBatch(apiKey, baseURL,
    "你输出纯JSON字符串数组。不要markdown，不要解释。",
    `生成45条中文FEEL通道边界样本。这些样本的特征是"表面像规则/决策(WHAT)，实质是用户在通过划边界来调节与AI的关系(FEEL)"。

真实参考：
${feelBoundaryRefs.map((r,i) => (i+1)+'. '+r).join('\n')}

要求：
- 每条15-60字
- 表面看起来像在陈述规则、提需求、做决策（容易误判为WHAT）
- 实质是在纠正AI行为、划定边界、表达不满或无奈（应该是FEEL）
- 自然口语化，不要固定句式
- 输出纯JSON数组`);

  allResults.push(...feel);

  // Save
  const outPath = "./tools/test-set-generated.json";
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2), "utf-8");
  const dist = {};
  allResults.forEach(x => dist[x.label] = (dist[x.label] || 0) + 1);
  console.error(`\nGenerated ${allResults.length} samples:`, JSON.stringify(dist));
  console.error(`Saved to ${outPath}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
