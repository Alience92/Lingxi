// eval-user-model-regression.ts — focused regressions for V7 user model lifecycle
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_HOME = path.resolve(__dirname, "../../.bench/lingxi-v7-user-model-regression");
const DB_PATH = path.join(BENCH_HOME, "memory.db");
const OUTPUT_DIR = path.resolve(__dirname, "../../benchmark-results");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "v7-user-model-regression.json");
const PROJECT_ID = "C--Users-Administrator";
const PROFILE_ID = "regression_profile";
const OTHER_PROFILE_ID = "regression_other_profile";

process.env.LINGXI_HOME = BENCH_HOME;
process.env.LINGXI_PROJECT_ID = PROJECT_ID;
process.env.LINGXI_PROFILE_ID = PROFILE_ID;

import { openDb } from "../db/connection.js";
import { recordFragment } from "../core/state-gate.js";
import { internalizeUserModels, searchUserModels } from "../core/v7-long-term-memory.js";

interface UserModelRow {
  id: string;
  profile_id: string;
  text: string;
  status: string;
  confidence: number;
  evidence_count: number;
  superseded_by: string | null;
}

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
  }, "eval-user-model-regression");
}

function getModel(textPattern: string, profileId = PROFILE_ID): UserModelRow | undefined {
  const db = openDb(DB_PATH);
  return db.prepare(`
    SELECT id, profile_id, text, status, confidence, evidence_count, superseded_by
    FROM user_memory_models
    WHERE project_id = ? AND profile_id = ? AND text LIKE ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(PROJECT_ID, profileId, `%${textPattern}%`) as UserModelRow | undefined;
}

function main(): void {
  resetDb();
  ensureProjectRow();
  const db = openDb(DB_PATH);

  addFragment("old_push_a", "默认可以主动推送代码", "decision");
  addFragment("old_push_b", "默认可以主动推送代码", "decision");
  internalizeUserModels(PROJECT_ID, PROFILE_ID);
  addFragment("new_push_a", "默认不要主动推送代码，除非用户明确授权", "decision");
  addFragment("new_push_b", "默认不要主动推送代码，除非用户明确授权", "decision");
  internalizeUserModels(PROJECT_ID, PROFILE_ID);
  internalizeUserModels(PROJECT_ID, PROFILE_ID);
  const oldPush = getModel("默认可以主动推送代码");
  const newPush = getModel("默认不要主动推送代码");
  const supersededNotRevived = oldPush?.status === "superseded" && oldPush.superseded_by === newPush?.id;

  const styleA = addFragment("style_a", "用户偏好简洁直接的技术沟通风格", "preference");
  const styleB = addFragment("style_b", "用户偏好简洁直接的技术沟通风格", "preference");
  internalizeUserModels(PROJECT_ID, PROFILE_ID);
  const styleBeforeDelete = getModel("简洁直接");
  db.prepare("UPDATE fragments SET asset_state = 'user_deleted' WHERE id IN (?, ?)").run(styleA, styleB);
  internalizeUserModels(PROJECT_ID, PROFILE_ID);
  const styleAfterDelete = getModel("简洁直接");
  const deleteInvalidatesModel = styleBeforeDelete?.status === "active" && styleAfterDelete?.status === "deleted" && styleAfterDelete.evidence_count === 0;

  addFragment("other_style_a", "用户偏好非常详细和温和的解释", "preference", OTHER_PROFILE_ID);
  addFragment("other_style_b", "用户偏好非常详细和温和的解释", "preference", OTHER_PROFILE_ID);
  internalizeUserModels(PROJECT_ID, OTHER_PROFILE_ID);
  const ownSearch = searchUserModels("用户沟通风格", PROJECT_ID, PROFILE_ID, 5);
  const otherSearch = searchUserModels("用户沟通风格", PROJECT_ID, OTHER_PROFILE_ID, 5);
  const profileIsolation = !ownSearch.some((row) => /详细和温和/.test(row.text)) && otherSearch.some((row) => /详细和温和/.test(row.text));

  const report = {
    projectId: PROJECT_ID,
    profileId: PROFILE_ID,
    checks: {
      supersededNotRevived,
      deleteInvalidatesModel,
      profileIsolation,
    },
    models: {
      oldPush,
      newPush,
      styleBeforeDelete,
      styleAfterDelete,
      ownSearch,
      otherSearch,
    },
    pass: supersededNotRevived && deleteInvalidatesModel && profileIsolation,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

  console.log("用户模型回归:");
  console.log(`  supersededNotRevived=${supersededNotRevived}`);
  console.log(`  deleteInvalidatesModel=${deleteInvalidatesModel}`);
  console.log(`  profileIsolation=${profileIsolation}`);
  console.log(`  ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`结果已写入: ${OUTPUT_PATH}`);
  if (!report.pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error("用户模型回归测试失败:", error);
  process.exitCode = 1;
}
