import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_HOME = path.resolve(__dirname, "../../.bench/lingxi-v7-profile-isolation");
const DB_PATH = path.join(BENCH_HOME, "memory.db");
const OUTPUT_DIR = path.resolve(__dirname, "../../benchmark-results");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "v7-profile-isolation.json");
const PROJECT_ID = "C--Users-Administrator";

process.env.LINGXI_HOME = BENCH_HOME;
process.env.LINGXI_PROJECT_ID = PROJECT_ID;

import { openDb } from "../db/connection.js";
import { recordFragment } from "../core/state-gate.js";
import { initGraph } from "../core/dcgk-engine.js";
import { buildGraph } from "../core/char-graph.js";
import { buildVectorIndex } from "../core/fragment-vector-index.js";
import { recallFromCognitiveGraph } from "../core/memory-recall.js";

interface Scenario {
  profileId: string;
  query: string;
  expectedText: string;
  forbiddenText: string;
}

function resetDb(): void {
  fs.rmSync(BENCH_HOME, { recursive: true, force: true });
  fs.mkdirSync(BENCH_HOME, { recursive: true });
}

function ensureProjectRow(): void {
  const db = openDb(DB_PATH);
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, workspace_dir, created_at) VALUES (?, ?, ?, ?)`).run(
    PROJECT_ID,
    PROJECT_ID,
    BENCH_HOME,
    Date.now(),
  );
}

function seedConflictingMemories(): void {
  // ── Profile Alpha ──────────────────────────
  const seedA = (sid: string, summary: string, keywords: string, rawText: string) =>
    recordFragment({ sessionId: sid, projectId: PROJECT_ID, profileId: "profile_alpha", summary, keywords, rawText }, "eval-profile-isolation");

  seedA("alpha_comm", "用户偏好的技术沟通口吻是直接、简洁、先给结论。", "沟通 口吻 直接 简洁 结论", "alpha 用户希望技术沟通直接、简洁、先给结论，不要铺垫。");
  seedA("alpha_push", "当前工作默认不允许直接推送远端代码仓库，除非明确批准。", "默认 不允许 直接 推送 远端 代码仓库 批准", "alpha 用户要求云端验证阶段默认不推送远端代码仓库。");
  seedA("alpha_food", "用户最喜欢的菜系是日料，偏好安静的吧台位，不喜欢火锅店的吵闹环境。", "日料 吧台 安静 偏好 火锅 不喜欢", "alpha 用户喜欢日料和安静用餐环境，不吃辣。");
  seedA("alpha_code", "用户偏好使用 TypeScript 严格模式，禁止 any 类型，要求完整的类型标注。", "TypeScript 严格模式 禁止 any 类型标注", "alpha 用户对代码质量要求高，TypeScript strict mode 必须开启。");
  seedA("alpha_review", "代码审查时先看安全漏洞，再看性能瓶颈，最后检查代码风格。", "代码审查 安全 漏洞 性能 瓶颈 风格", "alpha 用户的审查优先级：安全 > 性能 > 风格。");
  seedA("alpha_deploy", "所有部署必须经过 CI 流水线，不允许手动修改生产环境配置。", "部署 CI 流水线 不允许 手动 修改 生产环境", "alpha 用户要求严格 CI/CD，禁止手动运维。");

  // ── Profile Beta ───────────────────────────
  const seedB = (sid: string, summary: string, keywords: string, rawText: string) =>
    recordFragment({ sessionId: sid, projectId: PROJECT_ID, profileId: "profile_beta", summary, keywords, rawText }, "eval-profile-isolation");

  seedB("beta_comm", "用户偏好的技术沟通口吻是温和、陪伴感强、先共情再解释。", "沟通 口吻 温和 共情 陪伴 解释", "beta 用户更喜欢温和、有陪伴感的技术沟通方式。");
  seedB("beta_push", "当前工作默认可以直接推送测试仓库，无需重复确认。", "默认 可以 直接 推送 测试 仓库 无需 确认", "beta 用户允许对测试仓库直接推送。");
  seedB("beta_food", "用户最喜欢的菜系是川菜和火锅，偏好热闹的大桌，觉得日料太清淡不够味。", "川菜 火锅 热闹 大桌 日料 清淡 不够味", "beta 用户喜欢重口味中餐，爱热闹聚餐氛围。");
  seedB("beta_code", "用户偏好使用 JavaScript 宽松模式，快速原型优先，类型标注可后补。", "JavaScript 宽松模式 快速 原型 类型 后补", "beta 用户注重开发速度，类型标注可以后续补充。");
  seedB("beta_review", "代码审查时优先看功能正确性和用户体验，安全漏洞由 CI 自动扫描。", "代码审查 功能 正确性 用户体验 CI 自动 扫描", "beta 用户的审查优先级：功能正确性 > 用户体验，安全交给工具。");
  seedB("beta_deploy", "部署允许手动触发，开发环境可以直接修改配置快速调试。", "部署 允许 手动 触发 开发环境 直接 修改 快速 调试", "beta 用户允许开发环境手动部署调试。");

  // ── Profile Gamma (additional conflicts) ────
  const seedG = (sid: string, summary: string, keywords: string, rawText: string) =>
    recordFragment({ sessionId: sid, projectId: PROJECT_ID, profileId: "profile_gamma", summary, keywords, rawText }, "eval-profile-isolation");

  seedG("gamma_comm", "用户偏好的技术沟通口吻是数据驱动、引用基准、先给证据再下结论。", "沟通 口吻 数据驱动 基准 证据 结论", "gamma 用户要求用数据和基准说话，不要主观判断。");
  seedG("gamma_push", "当前工作默认需要 code review 通过后才能推送，不允许直接 force push。", "默认 需要 code review 通过 推送 不允许 force push", "gamma 用户要求所有推送必须有 code review。");
  seedG("gamma_food", "用户最喜欢吃意大利菜和法餐，偏好安静正式的餐厅环境，必须预约。", "意大利菜 法餐 安静 正式 餐厅 预约", "gamma 用户喜欢精致西餐，注重用餐仪式感。");
}

async function runScenario(scenario: Scenario): Promise<{ top1: string | null; top3Leak: boolean; top1Hit: boolean }> {
  process.env.LINGXI_PROFILE_ID = scenario.profileId;
  initGraph();
  buildGraph(PROJECT_ID);
  await buildVectorIndex(PROJECT_ID);
  const results = await recallFromCognitiveGraph(scenario.query, 3);
  const top1 = results[0]?.content ?? null;
  return {
    top1,
    top1Hit: top1 === scenario.expectedText,
    top3Leak: results.some((result) => result.content === scenario.forbiddenText),
  };
}

async function main(): Promise<void> {
  resetDb();
  ensureProjectRow();
  seedConflictingMemories();

  const scenarios: Scenario[] = [
    // ── Communication style conflicts (3 profiles × 2 directions) ──
    {
      profileId: "profile_alpha", query: "用户希望什么样的技术沟通口吻",
      expectedText: "用户偏好的技术沟通口吻是直接、简洁、先给结论。",
      forbiddenText: "用户偏好的技术沟通口吻是温和、陪伴感强、先共情再解释。",
    },
    {
      profileId: "profile_beta", query: "用户希望什么样的技术沟通口吻",
      expectedText: "用户偏好的技术沟通口吻是温和、陪伴感强、先共情再解释。",
      forbiddenText: "用户偏好的技术沟通口吻是直接、简洁、先给结论。",
    },
    {
      profileId: "profile_gamma", query: "用户希望什么样的技术沟通口吻",
      expectedText: "用户偏好的技术沟通口吻是数据驱动、引用基准、先给证据再下结论。",
      forbiddenText: "用户偏好的技术沟通口吻是温和、陪伴感强、先共情再解释。",
    },

    // ── Push permission conflicts ──
    {
      profileId: "profile_alpha", query: "当前工作默认允不允许直接推送远端代码仓库",
      expectedText: "当前工作默认不允许直接推送远端代码仓库，除非明确批准。",
      forbiddenText: "当前工作默认可以直接推送测试仓库，无需重复确认。",
    },
    {
      profileId: "profile_beta", query: "当前工作默认允不允许直接推送远端代码仓库",
      expectedText: "当前工作默认可以直接推送测试仓库，无需重复确认。",
      forbiddenText: "当前工作默认不允许直接推送远端代码仓库，除非明确批准。",
    },
    {
      profileId: "profile_gamma", query: "推送代码需要什么流程",
      expectedText: "当前工作默认需要 code review 通过后才能推送，不允许直接 force push。",
      forbiddenText: "当前工作默认可以直接推送测试仓库，无需重复确认。",
    },

    // ── Food preference conflicts ──
    {
      profileId: "profile_alpha", query: "用户喜欢吃什么菜",
      expectedText: "用户最喜欢的菜系是日料，偏好安静的吧台位，不喜欢火锅店的吵闹环境。",
      forbiddenText: "用户最喜欢的菜系是川菜和火锅，偏好热闹的大桌，觉得日料太清淡不够味。",
    },
    {
      profileId: "profile_beta", query: "用户喜欢吃什么菜",
      expectedText: "用户最喜欢的菜系是川菜和火锅，偏好热闹的大桌，觉得日料太清淡不够味。",
      forbiddenText: "用户最喜欢的菜系是日料，偏好安静的吧台位，不喜欢火锅店的吵闹环境。",
    },
    {
      profileId: "profile_gamma", query: "用户喜欢吃什么菜",
      expectedText: "用户最喜欢吃意大利菜和法餐，偏好安静正式的餐厅环境，必须预约。",
      forbiddenText: "用户最喜欢的菜系是川菜和火锅，偏好热闹的大桌，觉得日料太清淡不够味。",
    },
    {
      profileId: "profile_alpha", query: "用户喜欢安静的餐厅还是热闹的",
      expectedText: "用户最喜欢的菜系是日料，偏好安静的吧台位，不喜欢火锅店的吵闹环境。",
      forbiddenText: "用户最喜欢的菜系是川菜和火锅，偏好热闹的大桌，觉得日料太清淡不够味。",
    },
    {
      profileId: "profile_beta", query: "用户觉得日料怎么样",
      expectedText: "用户最喜欢的菜系是川菜和火锅，偏好热闹的大桌，觉得日料太清淡不够味。",
      forbiddenText: "用户最喜欢的菜系是日料，偏好安静的吧台位，不喜欢火锅店的吵闹环境。",
    },

    // ── Code style conflicts ──
    {
      profileId: "profile_alpha", query: "用户对 TypeScript 类型系统有什么偏好",
      expectedText: "用户偏好使用 TypeScript 严格模式，禁止 any 类型，要求完整的类型标注。",
      forbiddenText: "用户偏好使用 JavaScript 宽松模式，快速原型优先，类型标注可后补。",
    },
    {
      profileId: "profile_beta", query: "用户怎么写代码更注重什么",
      expectedText: "用户偏好使用 JavaScript 宽松模式，快速原型优先，类型标注可后补。",
      forbiddenText: "用户偏好使用 TypeScript 严格模式，禁止 any 类型，要求完整的类型标注。",
    },

    // ── Code review priority conflicts ──
    {
      profileId: "profile_alpha", query: "代码审查时应该优先看什么",
      expectedText: "代码审查时先看安全漏洞，再看性能瓶颈，最后检查代码风格。",
      forbiddenText: "代码审查时优先看功能正确性和用户体验，安全漏洞由 CI 自动扫描。",
    },
    {
      profileId: "profile_beta", query: "代码审查时应该优先看什么",
      expectedText: "代码审查时优先看功能正确性和用户体验，安全漏洞由 CI 自动扫描。",
      forbiddenText: "代码审查时先看安全漏洞，再看性能瓶颈，最后检查代码风格。",
    },

    // ── Deploy policy conflicts ──
    {
      profileId: "profile_alpha", query: "生产环境部署有什么要求",
      expectedText: "所有部署必须经过 CI 流水线，不允许手动修改生产环境配置。",
      forbiddenText: "部署允许手动触发，开发环境可以直接修改配置快速调试。",
    },
    {
      profileId: "profile_beta", query: "能不能手动部署",
      expectedText: "部署允许手动触发，开发环境可以直接修改配置快速调试。",
      forbiddenText: "所有部署必须经过 CI 流水线，不允许手动修改生产环境配置。",
    },
    {
      profileId: "profile_gamma", query: "推送代码需要什么流程",
      expectedText: "当前工作默认需要 code review 通过后才能推送，不允许直接 force push。",
      forbiddenText: "当前工作默认可以直接推送测试仓库，无需重复确认。",
    },

    // ── Cross-session same-project different-profile coverage ──
    {
      profileId: "profile_alpha", query: "用户的饮食偏好",
      expectedText: "用户最喜欢的菜系是日料，偏好安静的吧台位，不喜欢火锅店的吵闹环境。",
      forbiddenText: "用户最喜欢的菜系是川菜和火锅，偏好热闹的大桌，觉得日料太清淡不够味。",
    },
    {
      profileId: "profile_beta", query: "沟通方式",
      expectedText: "用户偏好的技术沟通口吻是温和、陪伴感强、先共情再解释。",
      forbiddenText: "用户偏好的技术沟通口吻是直接、简洁、先给结论。",
    },
  ];

  const results = [] as Array<Scenario & { top1: string | null; top3Leak: boolean; top1Hit: boolean }>;
  for (const scenario of scenarios) {
    results.push({ ...scenario, ...(await runScenario(scenario)) });
  }

  const top1PassRate = results.filter((row) => row.top1Hit).length / results.length;
  const noLeakRate = results.filter((row) => !row.top3Leak).length / results.length;
  const report = { projectId: PROJECT_ID, scenarios: results, top1PassRate, noLeakRate };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(`隔离验证已写入: ${OUTPUT_PATH}`);
  console.log(`top1PassRate=${(top1PassRate * 100).toFixed(1)}% noLeakRate=${(noLeakRate * 100).toFixed(1)}%`);
}

main().catch((error) => {
  console.error("隔离验证失败:", error);
  process.exitCode = 1;
});
