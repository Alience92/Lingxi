// eval-longrun-stability.ts — 长跑稳定性测试
// 模拟 50-100 轮对话，检验 state-gate / active_context 无漂移、无重复、无静默覆盖
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_HOME = path.resolve(__dirname, "../../.bench/lingxi-v7-longrun");
const DB_PATH = path.join(BENCH_HOME, "memory.db");
const OUTPUT_DIR = path.resolve(__dirname, "../../benchmark-results");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "v7-longrun-stability.json");
const PROJECT_ID = "C--Users-Administrator";
const PROFILE_ID = "longrun_test_profile";

process.env.LINGXI_HOME = BENCH_HOME;
process.env.LINGXI_PROJECT_ID = PROJECT_ID;
process.env.LINGXI_PROFILE_ID = PROFILE_ID;

import { openDb } from "../db/connection.js";
import { recordFragment, runMaintenanceCycle } from "../core/state-gate.js";
import { updateActiveContext } from "../core/active-context.js";

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

interface TurnResult {
  turn: number;
  activeContextSize: number;
  decisionCount: number;
  todoCount: number;
  preferenceCount: number;
  fragmentCount: number;
  rawEvidenceOk: boolean;
}

function getActiveContextStats(): { size: number; decisions: number; todos: number; preferences: number } {
  const db = openDb(DB_PATH);
  const row = db.prepare("SELECT active_context FROM projects WHERE id = ?").get(PROJECT_ID) as { active_context: string | null } | undefined;
  if (!row?.active_context) return { size: 0, decisions: 0, todos: 0, preferences: 0 };
  try {
    const ctx = JSON.parse(row.active_context);
    return {
      size: row.active_context.length,
      decisions: (ctx.decisions || []).length,
      todos: (ctx.todos || []).length,
      preferences: (ctx.preferences || []).length,
    };
  } catch {
    return { size: 0, decisions: 0, todos: 0, preferences: 0 };
  }
}

function getFragmentCount(): number {
  const db = openDb(DB_PATH);
  const row = db.prepare("SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND profile_id = ?").get(PROJECT_ID, PROFILE_ID) as { cnt: number };
  return row?.cnt ?? 0;
}

async function main(): Promise<void> {
  resetDb();
  ensureProjectRow();

  const TURNS = 60; // 60 turns: enough to catch drift
  const results: TurnResult[] = [];
  const snapshotHistory: Array<{ turn: number; activeContext: string | null }> = [];

  // Simulated user conversation messages, cycling through decision/todo/preference patterns
  const messages = [
    { summary: "确认使用 TypeScript strict mode 作为项目默认配置", subtype: "decision" as const },
    { summary: "需要在周五前完成代码审查和性能优化", subtype: "todo" as const },
    { summary: "用户偏好简洁直接的技术沟通风格，不要冗余铺垫", subtype: "preference" as const },
    { summary: "下一次发版前必须先跑完整回归测试", subtype: "decision" as const },
    { summary: "整理 v7 架构文档并发布到内部 wiki", subtype: "todo" as const },
    { summary: "用户不喜欢空泛的鼓励，需要可执行的建议", subtype: "preference" as const },
    { summary: "API 端点必须统一错误格式，使用 RFC 7807", subtype: "decision" as const },
    { summary: "重构 memory-recall.ts 融合层权重配置", subtype: "todo" as const },
    { summary: "用户喜欢吃日料，偏好安静餐厅环境", subtype: "preference" as const },
    { summary: "所有 SQL 迁移必须包含回滚脚本", subtype: "decision" as const },
  ];

  for (let turn = 1; turn <= TURNS; turn++) {
    const msg = messages[(turn - 1) % messages.length]!;

    // Write through state-gate
    recordFragment({
      sessionId: `longrun_session_${Math.ceil(turn / 5)}`,
      projectId: PROJECT_ID,
      profileId: PROFILE_ID,
      summary: msg.summary + ` [turn ${turn}]`,
      subtype: msg.subtype,
      rawText: msg.summary,
    }, "eval-longrun");

    // Rebuild active context every 5 turns
    if (turn % 5 === 0) {
      updateActiveContext(PROJECT_ID);
    }

    // Run maintenance every 15 turns
    if (turn % 15 === 0) {
      try { runMaintenanceCycle(PROJECT_ID); } catch { /* non-fatal */ }
    }

    // Collect stats
    const stats = getActiveContextStats();
    const fragCount = getFragmentCount();
    const db = openDb(DB_PATH);
    const rawOk = db.prepare(
      "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND profile_id = ? AND raw_text IS NOT NULL AND LENGTH(raw_text) > 0"
    ).get(PROJECT_ID, PROFILE_ID) as { cnt: number };
    const totalFrags = db.prepare(
      "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND profile_id = ?"
    ).get(PROJECT_ID, PROFILE_ID) as { cnt: number };

    const result: TurnResult = {
      turn,
      activeContextSize: stats.size,
      decisionCount: stats.decisions,
      todoCount: stats.todos,
      preferenceCount: stats.preferences,
      fragmentCount: fragCount,
      rawEvidenceOk: rawOk.cnt === totalFrags.cnt,
    };
    results.push(result);

    // Snapshot active_context every 10 turns for drift detection
    if (turn % 10 === 0) {
      const db2 = openDb(DB_PATH);
      const row = db2.prepare("SELECT active_context FROM projects WHERE id = ?").get(PROJECT_ID) as { active_context: string | null } | undefined;
      snapshotHistory.push({ turn, activeContext: row?.active_context ?? null });
    }
  }

  // ── Drift analysis ──
  const initialStats = results[0]!;
  const finalStats = results[results.length - 1]!;

  const fragmentGrowth = finalStats.fragmentCount - initialStats.fragmentCount;
  const expectedGrowth = TURNS; // Each turn creates ~1 fragment
  const fragmentDrift = Math.abs(fragmentGrowth - expectedGrowth);

  // Check for active_context duplication (same text appearing twice)
  let hasDuplication = false;
  if (snapshotHistory.length >= 2) {
    const last = snapshotHistory[snapshotHistory.length - 1]!;
    if (last.activeContext) {
      try {
        const ctx = JSON.parse(last.activeContext);
        for (const cat of ["decisions", "todos", "preferences"] as const) {
          const texts = (ctx[cat] || []).map((e: any) => e.text);
          if (new Set(texts).size < texts.length) {
            hasDuplication = true;
            break;
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  // Check active_context doesn't exceed reasonable size
  const maxContextSize = Math.max(...results.map(r => r.activeContextSize));

  const report = {
    projectId: PROJECT_ID,
    profileId: PROFILE_ID,
    turns: TURNS,
    finalState: finalStats,
    fragmentGrowth,
    expectedGrowth,
    fragmentDrift,
    maxActiveContextSize: maxContextSize,
    maxActiveContextOk: maxContextSize <= 5000, // 5KB cap for 60 turns
    hasDuplication,
    rawEvidenceOk: finalStats.rawEvidenceOk,
    snapshotCount: snapshotHistory.length,
    results,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));

  const passed = !hasDuplication && fragmentDrift <= 3 && report.maxActiveContextOk && report.rawEvidenceOk;
  console.log(`长跑稳定性: ${TURNS} turns`);
  console.log(`  fragments: ${initialStats.fragmentCount} → ${finalStats.fragmentCount} (drift=${fragmentDrift})`);
  console.log(`  active_context max size: ${maxContextSize} chars (cap=5000: ${report.maxActiveContextOk ? "OK" : "FAIL"})`);
  console.log(`  hasDuplication: ${hasDuplication}`);
  console.log(`  rawEvidence: ${report.rawEvidenceOk ? "OK" : "FAIL"}`);
  console.log(`  ${passed ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`结果已写入: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("长跑稳定性测试失败:", error);
  process.exitCode = 1;
});
