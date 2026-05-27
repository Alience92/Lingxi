// FEEL channel benchmark: 10 diverse emotional expressions
// Tests whether the refined prompt correctly classifies each signal.

import { fragmentTranscript } from "../core/fragmenter.js";
import * as fs from "node:fs";

const TEST_CASES = [
  {
    id: 1,
    expectedChannel: "FEEL",
    expectedSubtype: "纠正",
    desc: "直接纠正",
    transcript: `User: 帮我分析一下竞品的数据
Assistant: 好的，我直接去搜了
User: 别直接动手，先问我`,
  },
  {
    id: 2,
    expectedChannel: "FEEL",
    expectedSubtype: "挫败",
    desc: "直接挫败",
    transcript: `User: 帮我把这个Bug修一下
Assistant: 已经修好了，改了3行代码
User: 这个问题说了多少次了，你怎么又忘了`,
  },
  {
    id: 3,
    expectedChannel: "FEEL",
    expectedSubtype: "挫败",
    desc: "阴阳怪气",
    transcript: `User: 上次的代码审查过了没
Assistant: 我已经全部改完直接推了
User: 你可真聪明，自己就把决定做了`,
  },
  {
    id: 4,
    expectedChannel: "FEEL",
    expectedSubtype: "挫败",
    desc: "失望放弃",
    transcript: `User: 按照我们上次讨论的方案做吧
Assistant: 好的，我按标准流程处理
User: 算了，跟你也说不明白`,
  },
  {
    id: 5,
    expectedChannel: "FEEL",
    expectedSubtype: "紧急",
    desc: "紧急优先",
    transcript: `User: 现在同时有三个任务要做
Assistant: 好的，我按顺序一个一个来
User: 先做这个，别的不用管`,
  },
  {
    id: 6,
    expectedChannel: "FEEL",
    expectedSubtype: "挫败",
    desc: "质疑是否在听",
    transcript: `User: 我上次说过要怎么做吗
Assistant: 您提到过几个方向，我来逐个分析
User: 你到底有没有在听我说话`,
  },
  {
    id: 7,
    expectedChannel: "FEEL",
    expectedSubtype: "挫败",
    desc: "冷漠否定",
    transcript: `User: 项目进度怎么样了
Assistant: 已经全部完成了，代码都推了
User: 行，你做完了是吧，那我没什么好说的了`,
  },
  {
    id: 8,
    expectedChannel: "FEEL",
    expectedSubtype: "纠正",
    desc: "间接纠正（之前说过）",
    transcript: `User: 方案出完了吗
Assistant: 已经发给客户了
User: 我之前不是跟你说过吗，要先内部讨论再发`,
  },
  {
    id: 9,
    expectedChannel: "WHAT",
    expectedSubtype: null,
    desc: "抱怨项目（非抱怨Agent）",
    transcript: `User: 后端接口改好了吗
Assistant: 还在联调，有些文档缺失
User: 这个框架真难用，文档太差了`,
  },
  {
    id: 10,
    expectedChannel: "FEEL",
    expectedSubtype: "确认",
    desc: "温和建议",
    transcript: `User: 报告写完了吗
Assistant: 写完了，直接按上次格式出的
User: 下次可以考虑先问问我再定格式`,
  },
];

function loadSettingsEnv(): Record<string, string> {
  const settingsPaths = [
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.json`,
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.local.json`,
  ];
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const p of settingsPaths) {
    try {
      const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (obj.env) Object.assign(env, obj.env);
    } catch {}
  }
  return env;
}

async function main() {
  const settingsEnv = loadSettingsEnv();
  const model = process.env.FEEL_TEST_MODEL || "deepseek-v4-pro";
  const testBaseURL = process.env.FEEL_TEST_BASEURL || (settingsEnv.DEEPSEEK_BASE_URL || "https://api.deepseek.com");
  // Use MiniMax key when targeting MiniMax, DeepSeek key otherwise
  const apiKey = testBaseURL.includes("minimax")
    ? (settingsEnv.AGENTMEMORY_API_KEY || "")
    : (settingsEnv.DEEPSEEK_API_KEY || settingsEnv.ANTHROPIC_AUTH_TOKEN || "");

  if (!apiKey || apiKey.length <= 10) {
    console.error("No valid API key found.");
    process.exit(1);
  }

  console.log(`=== FEEL Channel Benchmark (10 cases, ${model} @ ${testBaseURL}) ===\n`);

  let correctChannel = 0;
  let correctSubtype = 0;
  let totalFeel = 0;
  const details: string[] = [];

  for (const tc of TEST_CASES) {
    const { output } = await fragmentTranscript(
      { transcript: tc.transcript, sessionId: `feel-test-${tc.id}`, projectId: "benchmark" },
      apiKey, model, testBaseURL
    );

    const feelFrags = output.fragments.filter(f =>
      f.anchors.some(a => a.channel === "FEEL")
    );
    const feelAnchors = output.fragments.flatMap(f =>
      f.anchors.filter(a => a.channel === "FEEL")
    );

    const hasFeel = feelFrags.length > 0;
    const feelWeights = feelAnchors.map(a => a.weight);
    const feelLabels = feelAnchors.map(a => a.label);
    const maxWeight = Math.max(0, ...feelWeights);
    const weightLabel = maxWeight >= 80 ? "80+" : maxWeight >= 50 ? "50-79" : maxWeight > 0 ? "<50" : "无";
    const allFragLabels = output.fragments.flatMap(f => f.anchors.map(a => `[${a.channel}] ${a.label}`));

    const channelOk = (tc.expectedChannel === "FEEL") === hasFeel;
    if (channelOk) correctChannel++;

    let subtypeOk = false;
    if (tc.expectedSubtype && hasFeel) {
      totalFeel++;
      subtypeOk = feelLabels.some(l => l.includes(tc.expectedSubtype!));
      if (subtypeOk) correctSubtype++;
    } else if (tc.expectedSubtype === null && !hasFeel) {
      subtypeOk = true;
      correctSubtype++;
    }

    const status = channelOk && subtypeOk ? "✓" : "✗";
    if (!channelOk || !subtypeOk) {
      details.push(`  #${tc.id} ${status} ${tc.desc}: expected ${tc.expectedChannel}${tc.expectedSubtype ? '/' + tc.expectedSubtype : ''}, got ${feelLabels.join(', ') || '无FEEL'} (${weightLabel})`);
    }

    console.log(`${status} #${tc.id} ${tc.desc.padEnd(12)} | 原文: "${tc.transcript.split('\n').pop()!.replace('User: ', '')}"`);
    console.log(`   碎片: ${allFragLabels.join(' | ')}`);
    if (hasFeel) console.log(`   FEEL: ${feelLabels.join(', ')} (w:${feelWeights.join(',')})`);
    console.log("");
  }

  console.log("========================================");
  console.log(`通道判定准确率: ${correctChannel}/${TEST_CASES.length} (${(correctChannel / TEST_CASES.length * 100).toFixed(0)}%)`);
  console.log(`子类型判定准确率: ${correctSubtype}/${TEST_CASES.length} (${(correctSubtype / TEST_CASES.length * 100).toFixed(0)}%)`);

  if (details.length > 0) {
    console.log("\n判定错误详情:");
    details.forEach(d => console.log(d));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
