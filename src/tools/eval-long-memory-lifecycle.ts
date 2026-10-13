// eval-long-memory-lifecycle.ts — 长期记忆膨胀 + 沙漏 + 用户建模验收
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_HOME = path.resolve(__dirname, "../../.bench/lingxi-v7-long-memory");
const DB_PATH = path.join(BENCH_HOME, "memory.db");
const OUTPUT_DIR = path.resolve(__dirname, "../../benchmark-results");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "v7-long-memory-lifecycle.json");
const PROJECT_ID = "C--Users-Administrator";
const PROFILE_ID = "long_memory_profile";

process.env.LINGXI_HOME = BENCH_HOME;
process.env.LINGXI_PROJECT_ID = PROJECT_ID;
process.env.LINGXI_PROFILE_ID = PROFILE_ID;

import { openDb } from "../db/connection.js";
import { recallFromCognitiveGraph } from "../core/memory-recall.js";
import { recordFragment, recordRecall, runMaintenanceCycle } from "../core/state-gate.js";
import { internalizeUserModels, runFragmentHourglass } from "../core/v7-long-term-memory.js";

function resetDb(): void {
  fs.rmSync(BENCH_HOME, { recursive: true, force: true });
  fs.mkdirSync(BENCH_HOME, { recursive: true });
}

function ensureProjectRow(): void {
  const db = openDb(DB_PATH);
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, workspace_dir, created_at) VALUES (?, ?, ?, ?)`).run(
    PROJECT_ID, PROJECT_ID, BENCH_HOME, Date.now(),
  );
}

function seed(): { activePreferenceId: string; revivedId: string } {
  const db = openDb(DB_PATH);
  const now = Date.now();
  const old = now - 95 * 24 * 60 * 60 * 1000;
  const mid = now - 35 * 24 * 60 * 60 * 1000;

  const repeatedPreference = "用户偏好简洁直接的技术沟通风格，不要冗余铺垫";
  const repeatedRule = "默认不要主动推送代码，除非用户明确授权";
  let activePreferenceId = "";
  for (let i = 0; i < 4; i++) {
    const id = recordFragment({
      sessionId: `model_pref_${i}`,
      projectId: PROJECT_ID,
      profileId: PROFILE_ID,
      summary: repeatedPreference,
      rawText: repeatedPreference,
      subtype: "preference",
    }, "eval-long-memory");
    if (!activePreferenceId) activePreferenceId = id;
    db.prepare("UPDATE fragments SET created_at = ? WHERE id = ?").run(now - i * 86_400_000, id);
  }
  for (let i = 0; i < 3; i++) {
    const id = recordFragment({
      sessionId: `model_rule_${i}`,
      projectId: PROJECT_ID,
      profileId: PROFILE_ID,
      summary: repeatedRule,
      rawText: repeatedRule,
      subtype: "decision",
    }, "eval-long-memory");
    db.prepare("UPDATE fragments SET created_at = ? WHERE id = ?").run(now - i * 86_400_000, id);
  }

  let revivedId = "";
  for (let i = 0; i < 1000; i++) {
    const topic = i % 2 === 0 ? "临时餐厅讨论" : "一次性项目闲聊";
    const summary = `${topic} ${i}: 这是一条低价值旧记忆，用于模拟长期数据膨胀噪声`;
    const id = recordFragment({
      sessionId: `noise_${Math.floor(i / 20)}`,
      projectId: PROJECT_ID,
      profileId: PROFILE_ID,
      summary,
      rawText: summary,
    }, "eval-long-memory");
    db.prepare("UPDATE fragments SET created_at = ? WHERE id = ?").run(i % 3 === 0 ? old : mid, id);
    if (i === 7) revivedId = id;
  }
  recordRecall(revivedId, "重新提到低价值旧记忆", 1.0, "eval-long-memory");
  return { activePreferenceId, revivedId };
}

function stateCounts(): Record<string, number> {
  const db = openDb(DB_PATH);
  const rows = db.prepare(`
    SELECT retrieval_state as state, COUNT(*) as cnt FROM fragments
    WHERE project_id = ? AND profile_id = ? AND asset_state != 'user_deleted'
    GROUP BY retrieval_state
  `).all(PROJECT_ID, PROFILE_ID) as Array<{ state: string; cnt: number }>;
  return Object.fromEntries(rows.map((row) => [row.state, row.cnt]));
}

async function main(): Promise<void> {
  resetDb();
  ensureProjectRow();
  const seeded = seed();

  const db = openDb(DB_PATH);
  const before = stateCounts();
  const hourglass = runFragmentHourglass({ projectId: PROJECT_ID, profileId: PROFILE_ID });
  const models = internalizeUserModels(PROJECT_ID, PROFILE_ID);
  const maintenance = await runMaintenanceCycle("eval-long-memory");
  const after = stateCounts();

  const revived = db.prepare("SELECT retrieval_state, decay_score FROM fragments WHERE id = ?").get(seeded.revivedId) as { retrieval_state: string; decay_score: number };
  const modelRows = db.prepare(`
    SELECT dimension, text, confidence, evidence_count FROM user_memory_models
    WHERE project_id = ? AND profile_id = ? ORDER BY confidence DESC, evidence_count DESC
  `).all(PROJECT_ID, PROFILE_ID) as Array<{ dimension: string; text: string; confidence: number; evidence_count: number }>;

  const recallStyle = await recallFromCognitiveGraph("用户喜欢我怎么沟通和回答", 5);
  const recallRule = await recallFromCognitiveGraph("默认能不能主动推送代码", 5);
  const styleTop1 = recallStyle[0]?.source === "user_model" && /简洁直接/.test(recallStyle[0]?.content ?? "");
  const ruleTop1 = recallRule[0]?.source === "user_model" && /主动推送代码/.test(recallRule[0]?.content ?? "");

  const report = {
    projectId: PROJECT_ID,
    profileId: PROFILE_ID,
    seededFragments: 1007,
    before,
    after,
    hourglass,
    models,
    maintenance,
    revived,
    userModels: modelRows,
    recall: {
      styleTop1,
      ruleTop1,
      styleResults: recallStyle.map((row) => ({ source: row.source, score: row.score, content: row.content })),
      ruleResults: recallRule.map((row) => ({ source: row.source, score: row.score, content: row.content })),
    },
    pass: Boolean((after.archived || 0) + (after.cold || 0) > 700 && revived.retrieval_state === "active" && modelRows.length >= 2 && styleTop1 && ruleTop1),
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

  console.log(`长期记忆生命周期: seeded=${report.seededFragments}`);
  console.log(`  states before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  console.log(`  models created=${models.created} reinforced=${models.reinforced}`);
  console.log(`  revived=${revived.retrieval_state}/${revived.decay_score}`);
  console.log(`  styleTop1=${styleTop1} ruleTop1=${ruleTop1}`);
  console.log(`  ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`结果已写入: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("长期记忆生命周期测试失败:", error);
  process.exitCode = 1;
});
