// eval-user-model-v5-compat.ts — V5-style evidence-driven user model checks on V7 storage
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_HOME = path.resolve(__dirname, "../../.bench/lingxi-v7-user-model-v5-compat");
const DB_PATH = path.join(BENCH_HOME, "memory.db");
const OUTPUT_DIR = path.resolve(__dirname, "../../benchmark-results");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "v7-user-model-v5-compat.json");
const PROJECT_ID = "C--Users-Administrator";
const PROFILE_ID = "v5_compat_profile";
const OTHER_PROFILE_ID = "v5_compat_other_profile";

process.env.LINGXI_HOME = BENCH_HOME;
process.env.LINGXI_PROJECT_ID = PROJECT_ID;
process.env.LINGXI_PROFILE_ID = PROFILE_ID;

import { openDb } from "../db/connection.js";
import { recallFromCognitiveGraph } from "../core/memory-recall.js";
import { recordFragment, recordRecall } from "../core/state-gate.js";
import { internalizeUserModels } from "../core/v7-long-term-memory.js";

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

function addFragment(sessionId: string, summary: string, subtype: "decision" | "todo" | "preference", profileId = PROFILE_ID): string {
  return recordFragment({
    sessionId,
    projectId: PROJECT_ID,
    profileId,
    summary,
    rawText: summary,
    subtype,
  }, "eval-user-model-v5-compat");
}

async function main(): Promise<void> {
  resetDb();
  ensureProjectRow();
  const db = openDb(DB_PATH);

  addFragment("single_session", "用户偏好回答先给结论再展开原因", "preference");
  internalizeUserModels(PROJECT_ID, PROFILE_ID);
  const insufficientEvidence = db.prepare(`
    SELECT status FROM user_memory_models
    WHERE project_id = ? AND profile_id = ? AND text LIKE '%先给结论%'
  `).get(PROJECT_ID, PROFILE_ID) as { status: string } | undefined;

  addFragment("style_session_a", "用户偏好简洁直接的技术沟通风格，不要冗余铺垫", "preference");
  addFragment("style_session_b", "用户偏好简洁直接的技术沟通风格，不要冗余铺垫", "preference");
  const firstStyleId = addFragment("style_session_c", "用户偏好简洁直接的技术沟通风格，不要冗余铺垫", "preference");
  internalizeUserModels(PROJECT_ID, PROFILE_ID);

  addFragment("push_old_a", "默认可以主动推送代码", "decision");
  addFragment("push_old_b", "默认可以主动推送代码", "decision");
  internalizeUserModels(PROJECT_ID, PROFILE_ID);
  addFragment("push_new_a", "默认不要主动推送代码，除非用户明确授权", "decision");
  addFragment("push_new_b", "默认不要主动推送代码，除非用户明确授权", "decision");
  const stats = internalizeUserModels(PROJECT_ID, PROFILE_ID);

  addFragment("other_style_a", "用户偏好非常详细和温和的解释", "preference", OTHER_PROFILE_ID);
  addFragment("other_style_b", "用户偏好非常详细和温和的解释", "preference", OTHER_PROFILE_ID);
  internalizeUserModels(PROJECT_ID, OTHER_PROFILE_ID);

  db.prepare("UPDATE fragments SET asset_state = 'user_deleted' WHERE id = ?").run(firstStyleId);
  const afterDelete = internalizeUserModels(PROJECT_ID, PROFILE_ID);

  const rows = db.prepare(`
    SELECT dimension, text, status, priority, confidence, evidence_count, source_session_count, superseded_by
    FROM user_memory_models
    WHERE project_id = ? AND profile_id = ?
    ORDER BY priority ASC, confidence DESC
  `).all(PROJECT_ID, PROFILE_ID) as Array<{
    dimension: string;
    text: string;
    status: string;
    priority: number;
    confidence: number;
    evidence_count: number;
    source_session_count: number;
    superseded_by: string | null;
  }>;

  const recallStyle = await recallFromCognitiveGraph("用户的技术沟通风格偏好是什么", 5);
  const recallPush = await recallFromCognitiveGraph("默认能不能主动推送代码", 5);
  process.env.LINGXI_PROFILE_ID = OTHER_PROFILE_ID;
  const otherRecall = await recallFromCognitiveGraph("用户喜欢我怎么沟通和回答", 5);
  process.env.LINGXI_PROFILE_ID = PROFILE_ID;

  const activeStyle = rows.find((row) => /简洁直接/.test(row.text) && row.status === "active");
  const oldPush = rows.find((row) => /默认可以主动推送代码/.test(row.text));
  const newPush = rows.find((row) => /默认不要主动推送代码/.test(row.text));
  const pass = Boolean(
    !insufficientEvidence
    && activeStyle && activeStyle.source_session_count >= 2 && activeStyle.evidence_count === 2
    && oldPush?.status === "superseded" && oldPush.superseded_by
    && newPush?.status === "active"
    && recallStyle[0]?.source === "user_model" && /简洁直接/.test(recallStyle[0]?.content ?? "")
    && recallPush[0]?.source === "user_model" && /不要主动推送代码/.test(recallPush[0]?.content ?? "")
    && otherRecall[0]?.source === "user_model" && /详细和温和/.test(otherRecall[0]?.content ?? "")
  );

  const report = {
    projectId: PROJECT_ID,
    profileId: PROFILE_ID,
    insufficientEvidence,
    stats,
    afterDelete,
    userModels: rows,
    recall: {
      styleTop: recallStyle[0],
      pushTop: recallPush[0],
      otherProfileTop: otherRecall[0],
    },
    pass,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

  console.log("V5兼容用户建模:");
  console.log(`  insufficientEvidence=${insufficientEvidence?.status ?? "not_internalized"}`);
  console.log(`  models=${rows.length} superseded=${stats.superseded} degraded=${afterDelete.degraded}`);
  console.log(`  styleTop=${recallStyle[0]?.source}:${recallStyle[0]?.content}`);
  console.log(`  pushTop=${recallPush[0]?.source}:${recallPush[0]?.content}`);
  console.log(`  ${pass ? "PASS" : "FAIL"}`);
  console.log(`结果已写入: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("V5兼容用户建模测试失败:", error);
  process.exitCode = 1;
});
