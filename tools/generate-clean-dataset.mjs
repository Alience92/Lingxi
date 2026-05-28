// Generate a CLEAN synthetic training dataset for the encoder classifier.
// NO user data is used as seed — all samples are generated from abstract
// domain descriptions and persona profiles. The resulting model will be
// a "clean base" that can be distributed without carrying personalized data.
//
// Target: ~2000 samples across WHAT/FEEL/WHERE/WHO + boundary cases,
// covering 10 technical domains and 5 expression personas.

import * as fs from "node:fs";
import * as path from "node:path";

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

// ── Domain & persona definitions ──────────────────────────

const DOMAINS = [
  "Web前端开发（React/Vue/Angular/CSS/TypeScript/组件设计/状态管理/性能优化）",
  "后端开发（API设计/数据库/认证授权/微服务/消息队列/缓存策略/Go/Java/Python）",
  "移动端开发（iOS Swift/Android Kotlin/Flutter/React Native/推送/离线存储）",
  "游戏开发（Unity/Godot/Unreal/物理引擎/渲染管线/资源管理/帧率优化）",
  "数据工程与AI（数据管道/特征工程/模型训练/MLOps/Spark/特征存储/向量数据库）",
  "DevOps与基础设施（Docker/K8s/CI-CD/Terraform/监控告警/日志系统/云服务）",
  "安全与合规（加密算法/零信任架构/PKI/OWASP/GDPR合规/渗透测试/审计日志）",
  "桌面应用开发（Electron/Tauri/WPF/Qt/跨平台打包/自动更新/原生模块）",
  "嵌入式与IoT（ARM编译/RTOS/驱动开发/MQTT协议/低功耗设计/BLE通信）",
  "通用软件工程（代码规范/Git工作流/技术选型/架构评审/重构策略/文档编写）",
];

const PERSONAS = [
  { name: "急躁型", traits: "说话简短直接，常用口语词如'算了''服了''搞什么'，不耐烦时语气冲但不粗鲁。纠正AI时直奔主题不拐弯。" },
  { name: "温和型", traits: "表达委婉有礼貌，纠正前会铺垫，认可时很真诚。常用'麻烦你''能不能''如果可以的话'等礼貌表达。" },
  { name: "技术型", traits: "用精确的技术语言表达，纠正时引用具体方法名/参数/配置。对AI的反馈也像code review，就事论事。" },
  { name: "幽默型", traits: "带讽刺或自嘲表达不满或认可。会说'你又在编故事了''这波操作给你满分''你可真是个小天才'等。" },
  { name: "新手型", traits: "语气不确定，试探性地提出需求或纠正。常用'可能是我没说清楚''我不太确定但是…''能不能帮我看看'。" },
];

// ── Prompt builders ────────────────────────────────────────

function buildWhatPrompt(domain, count) {
  return `生成${count}条中文技术对话片段，属于"${domain}"领域。

每条片段是一个软件工程师在工作中可能说的话，内容涉及技术决策、方案讨论、需求描述、架构评审、代码实现细节。

要求：
- 每条20-80字，像真实工作对话中的一句话或一段简短陈述
- 不要用"我觉得""我认为"开头——直接说技术内容
- 内容涉及具体技术细节（框架名、算法名、设计模式、性能指标等）
- 领域多样：有的关于性能、有的关于架构、有的关于代码质量、有的关于工具选择
- 避免任何涉及用户对AI的反馈、纠正、认可——纯粹的技术内容陈述
- 不要编号，不要前缀

输出纯JSON字符串数组，不要markdown代码块，不要任何解释。`;
}

function buildFeelPrompt(persona, count) {
  return `生成${count}条中文对话片段，模拟一个"${persona.name}"的软件工程师在跟AI编程助手协作时的反馈。

说话人特点：${persona.traits}

片段类型分布：
- 40% 纠正AI的错误（理解偏差、技术错误、遗漏细节）
- 25% 认可AI的工作（方向对了、结果好、效率高）
- 20% 催促或设定优先级（"先做这个""别管那个了"）
- 15% 设定边界或规则（"不要替我决定""保留这段代码"）

关键要求：
- 每条15-60字，自然口语化
- 必须有句子间的多样性——不同句式、不同语气强度
- 有的直接有的含蓄，有的带情绪有的冷静
- 不要用"用户指出""用户说"等第三人称——直接用第一人称或对话原句
- 不要编号，不要前缀
- 避免固定的开头模式

输出纯JSON字符串数组，不要markdown代码块，不要任何解释。`;
}

function buildWherePrompt(count) {
  return `生成${count}条中文技术对话片段，每条涉及一个"位置/环境"信息。

覆盖以下场景类型（均匀分布）：
- 文件路径操作（不同OS风格：Windows D:/xxx、Linux /home/xxx、Mac ~/xxx）
- 项目/模块/仓库名称引用
- 工具/平台/服务名称（IDE、云服务、数据库、消息队列、CI工具等）
- 版本号/时间节点/里程碑
- 环境配置（环境变量、配置文件、部署环境）

要求：
- 每条15-50字，自然融入对话语境——不要像在罗列路径
- 位置信息是句子的有机组成部分，不是孤立出现的
- 涉及至少8种不同的工具/平台/技术栈
- 不要编号，不要前缀

输出纯JSON字符串数组，不要markdown代码块，不要任何解释。`;
}

function buildWhoPrompt(count) {
  return `生成${count}条中文技术对话片段，每条涉及人物/角色/协作关系。

覆盖以下场景类型（均匀分布）：
- 提到同事/团队成员及其职责（"老张负责后端""小李是PM"）
- 协作关系（"这个接口我跟前端对过了""PM说优先级要改"）
- 汇报/审批关系（"需要技术负责人review""让CTO看一下"）
- 外部人员（客户、用户、供应商、开源社区维护者）
- 技能/角色描述（"我没写过Rust""你是专门做前端的"）

要求：
- 每条15-50字，自然融入对话语境
- 人物信息是句子有机部分，不是孤立描述
- 角色多样：PM、设计师、后端、前端、QA、DevOps、经理、客户等
- 不要编号，不要前缀

输出纯JSON字符串数组，不要markdown代码块，不要任何解释。`;
}

function buildBoundaryFeelPrompt(count) {
  return `生成${count}条中文对话片段。这些片段"表面上像技术决策或规则陈述，但实际上是对AI助手工作方式的边界设定或关系调节"。

特征：
- 片段字面上是在说系统/代码/设计应该怎样
- 但深层是在告诉AI："别越界""尊重我的判断""记住我的偏好"
- 没有明显的情绪词（如"你又""搞什么""服了"）
- 语气冷静、克制，像在陈述技术事实

示例风格（不要直接复制，只感受风格）：
- "方案里保留手动回滚的入口，自动化不是万能的"
- "这段逻辑我写了大半年才稳定下来，重构的时候小心点"
- "别动那个配置，线上的血泪教训都在里面"

要求：
- 每条20-60字
- 表面是技术/规则陈述，实质是告诉AI尊重用户的判断和偏好
- 覆盖不同领域（不只是某个特定技术栈）
- 不要编号，不要前缀

输出纯JSON字符串数组，不要markdown代码块，不要任何解释。`;
}

function buildBoundaryWhatPrompt(count) {
  return `生成${count}条中文对话片段。这些片段"表面上带评价/纠正/确认语气，容易让人误判为用户对AI行为的反馈，但实际上是在评价系统、代码、方案或数据本身，是对技术事实的判断而非对AI行为的反馈"。

特征：
- 含有评价性词汇（"太慢""有问题""好消息""不可接受""很正面"）
- 但评价对象是系统性能/代码质量/方案优劣/数据结果，不是AI的行为
- 如果只看词面会误判为FEEL，看主语义则应该是WHAT

示例风格（不要直接复制，只感受风格）：
- "缓存命中率92%是好消息，瓶颈在数据库连接池"
- "这版UI性能测试结果不可接受，首屏渲染超过3秒"
- "审查结论很正面：架构从单体拆成微服务之后，部署成功率提升到99%"

要求：
- 每条30-70字
- 评价词指向系统/代码/数据/方案，不指向AI行为
- 覆盖不同技术领域
- 不要编号，不要前缀

输出纯JSON字符串数组，不要markdown代码块，不要任何解释。`;
}

// ── API call ──────────────────────────────────────────────

async function generate(prompt, label, retries = 3) {
  const env = loadSettingsEnv();
  const apiKey = env.DEEPSEEK_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  const baseURL = env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  if (!apiKey || apiKey.length < 10) throw new Error("No API key");

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [
            { role: "system", content: "你是一个训练数据生成器。只输出纯JSON字符串数组。每条是一个中文对话片段。不要markdown、不要解释、不要编号。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.95,
          max_tokens: 16384,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      const content = data.choices?.[0]?.message?.content || "";

      const match = content.match(/\[[\s\S]*\]/);
      if (!match) {
        console.error(`  No JSON array in response (attempt ${attempt + 1})`);
        continue;
      }

      const samples = JSON.parse(match[0]);
      // Filter and validate
      const valid = samples
        .filter(s => typeof s === "string" && s.length >= 8 && s.length <= 120)
        .map(s => JSON.stringify({ text: s, label }));
      return valid;
    } catch (e) {
      console.error(`  Error (attempt ${attempt + 1}):`, e.message?.slice(0, 80));
      if (attempt === retries - 1) throw e;
    }
  }
  return [];
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  const outPath = "D:/Lingxi-v4/tools/clean-training-dataset.jsonl";
  const allLines = [];

  // ── WHAT: 10 domains × 50 ──
  console.error("=== Generating WHAT samples (10 domains × 50) ===");
  for (const domain of DOMAINS) {
    const prompt = buildWhatPrompt(domain, 50);
    console.error(`  Domain: ${domain.slice(0, 40)}...`);
    try {
      const lines = await generate(prompt, "WHAT");
      console.error(`    -> ${lines.length} samples`);
      allLines.push(...lines);
    } catch (e) {
      console.error(`    FAILED:`, e.message?.slice(0, 60));
    }
  }

  // ── FEEL: 5 personas × 100 ──
  console.error("=== Generating FEEL samples (5 personas × 100) ===");
  for (const persona of PERSONAS) {
    const prompt = buildFeelPrompt(persona, 100);
    console.error(`  Persona: ${persona.name}`);
    try {
      const lines = await generate(prompt, "FEEL");
      console.error(`    -> ${lines.length} samples`);
      allLines.push(...lines);
    } catch (e) {
      console.error(`    FAILED:`, e.message?.slice(0, 60));
    }
  }

  // ── WHERE: 250 ──
  console.error("=== Generating WHERE samples (250) ===");
  try {
    const lines = await generate(buildWherePrompt(250), "WHERE");
    console.error(`  -> ${lines.length} samples`);
    allLines.push(...lines);
  } catch (e) {
    console.error(`  FAILED:`, e.message?.slice(0, 60));
  }

  // ── WHO: 200 ──
  console.error("=== Generating WHO samples (200) ===");
  try {
    const lines = await generate(buildWhoPrompt(200), "WHO");
    console.error(`  -> ${lines.length} samples`);
    allLines.push(...lines);
  } catch (e) {
    console.error(`  FAILED:`, e.message?.slice(0, 60));
  }

  // ── Boundary FEEL: 100 ──
  console.error("=== Generating Boundary FEEL samples (100) ===");
  try {
    const lines = await generate(buildBoundaryFeelPrompt(100), "FEEL");
    console.error(`  -> ${lines.length} samples`);
    allLines.push(...lines);
  } catch (e) {
    console.error(`  FAILED:`, e.message?.slice(0, 60));
  }

  // ── Boundary WHAT: 100 ──
  console.error("=== Generating Boundary WHAT samples (100) ===");
  try {
    const lines = await generate(buildBoundaryWhatPrompt(100), "WHAT");
    console.error(`  -> ${lines.length} samples`);
    allLines.push(...lines);
  } catch (e) {
    console.error(`  FAILED:`, e.message?.slice(0, 60));
  }

  // ── Save ──
  const unique = [...new Set(allLines)];
  const final = unique.filter(line => {
    try {
      const obj = JSON.parse(line);
      return obj.text && obj.text.length >= 8 && obj.label;
    } catch { return false; }
  });

  const content = final.join("\n") + "\n";
  fs.writeFileSync(outPath, content, "utf-8");

  // Stats
  const byLabel = {};
  for (const line of final) {
    const obj = JSON.parse(line);
    byLabel[obj.label] = (byLabel[obj.label] || 0) + 1;
  }

  console.error(`\n=== GENERATION COMPLETE ===`);
  console.error(`Total: ${final.length} samples (${allLines.length - final.length} duplicates removed)`);
  console.error(`By channel:`, byLabel);
  console.error(`Saved to: ${outPath}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
