#!/usr/bin/env npx tsx
// 探针式评测仪表板 —— 用真实使用数据评估记忆系统效果
// 不需要外部数据集，基于 query_events + recall_log 计算近似 precision/recall
// 用法: npx tsx tools/eval-dashboard.ts [projectId]

import { openDb, getDb } from "../src/db/connection.js";

const projectId = process.argv[2] || "C--Users-Administrator";

openDb();
const db = getDb();

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const PERIODS = [
  { label: "今天", start: NOW - 1 * DAY },
  { label: "最近3天", start: NOW - 3 * DAY },
  { label: "最近7天", start: NOW - 7 * DAY },
  { label: "全部", start: 0 },
];

console.log("灵犀 v4 探针式评测报告");
console.log(`项目: ${projectId}`);
console.log(`时间: ${new Date().toISOString()}\n`);

// 1. 检索量统计
const queryStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) as hits,
    SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) as misses,
    AVG(result_count) as avgResults
  FROM query_events
  WHERE project_id = ? AND source = 'prefetch'
`).get(projectId) as { total: number; hits: number; misses: number; avgResults: number };

console.log("=== 检索命中率 ===");
if (queryStats.total > 0) {
  const hitRate = (queryStats.hits / queryStats.total * 100).toFixed(1);
  console.log(`总检索: ${queryStats.total}`);
  console.log(`命中: ${queryStats.hits} (${hitRate}%)`);
  console.log(`零命中: ${queryStats.misses} (${(queryStats.misses/queryStats.total*100).toFixed(1)}%)`);
  console.log(`平均返回: ${queryStats.avgResults.toFixed(1)} 条\n`);
} else {
  console.log("暂无查询事件数据\n");
}

// 2. 召回效果 — 按时间段统计
console.log("=== 召回率趋势 ===");
for (const p of PERIODS) {
  const s = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) as hits
    FROM query_events
    WHERE project_id = ? AND source = 'prefetch' AND searched_at > ?
  `).get(projectId, p.start) as { total: number; hits: number };
  if (s.total > 0) {
    console.log(`  ${p.label}: ${s.hits}/${s.total} (${(s.hits/s.total*100).toFixed(1)}%)`);
  } else {
    console.log(`  ${p.label}: 无数据`);
  }
}

// 3. 碎片质量 — 使用频率分布
const freqStats = db.prepare(`
  SELECT
    CASE
      WHEN recalled_count = 0 THEN '从未被召回'
      WHEN recalled_count <= 3 THEN '低频(1-3)'
      WHEN recalled_count <= 10 THEN '中频(4-10)'
      ELSE '高频(>10)'
    END as tier,
    COUNT(*) as cnt
  FROM fragments
  WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
  GROUP BY tier ORDER BY MIN(recalled_count)
`).all(projectId) as Array<{ tier: string; cnt: number }>;

console.log("\n=== 碎片使用频率 ===");
const totalFrags = freqStats.reduce((s, r) => s + r.cnt, 0);
for (const f of freqStats) {
  console.log(`  ${f.tier}: ${f.cnt} (${(f.cnt/totalFrags*100).toFixed(1)}%)`);
}

// 4. 蒸馏规则覆盖
const ruleCount = (db.prepare(`SELECT COUNT(*) as c FROM distilled_rules WHERE superseded_by IS NULL`).get() as { c: number }).c;
const fragCount = totalFrags;
const distilledFrags = (db.prepare(`
  SELECT COUNT(DISTINCT rs.fragment_id) as c
  FROM rule_sources rs
`).get() as { c: number }).c;

console.log(`\n=== 蒸馏覆盖率 ===`);
console.log(`活跃碎片: ${fragCount}`);
console.log(`蒸馏规则: ${ruleCount}`);
console.log(`已蒸馏碎片: ${distilledFrags} (${fragCount > 0 ? (distilledFrags/fragCount*100).toFixed(1) : "0"}%)`);

// 5. 通道均衡
const channels = db.prepare(`
  SELECT fa.channel, COUNT(DISTINCT f.id) as cnt
  FROM fragments f
  JOIN fragment_anchors fa ON fa.fragment_id = f.id
  WHERE f.project_id = ? AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted'
  GROUP BY fa.channel ORDER BY cnt DESC
`).all(projectId) as Array<{ channel: string; cnt: number }>;

console.log("\n=== 通道分布 ===");
for (const c of channels) {
  const bar = "█".repeat(Math.round(c.cnt / totalFrags * 30));
  console.log(`  ${c.channel}: ${c.cnt} (${(c.cnt/totalFrags*100).toFixed(1)}%) ${bar}`);
}

// 6. 记忆质量评分（近似）
// precision ≈ hit_rate, "recall" ≈ 是否有记忆可用
const hitRate = queryStats.total > 0 ? queryStats.hits / queryStats.total : 0;
const coverage = fragCount > 0 ? distilledFrags / fragCount : 0;
const zeroHitRate = queryStats.total > 0 ? queryStats.misses / queryStats.total : 1;
const qualityScore = (hitRate * 0.5 + coverage * 0.3 + (1 - zeroHitRate) * 0.2) * 100;

console.log(`\n=== 综合评分 ===`);
console.log(`检索命中率: ${(hitRate*100).toFixed(1)}% (权重 50%)`);
console.log(`蒸馏覆盖率: ${(coverage*100).toFixed(1)}% (权重 30%)`);
console.log(`反零命中率: ${((1-zeroHitRate)*100).toFixed(1)}% (权重 20%)`);
console.log(`综合质量分: ${qualityScore.toFixed(1)}/100`);

// ── Phase 0A: Extended baseline metrics ──────────────────────────

// 7. Per-channel hit rate — which channels does retrieval serve best?
console.log("\n=== 分通道命中率 ===");
const chanHit = db.prepare(`
  SELECT fa.channel, COUNT(DISTINCT rl.fragment_id) as hits
  FROM recall_log rl
  JOIN fragment_anchors fa ON fa.fragment_id = rl.fragment_id
  WHERE rl.recalled_at > ?
  GROUP BY fa.channel ORDER BY hits DESC
`).all(NOW - 7 * DAY) as Array<{ channel: string; hits: number }>;
const totalHits = chanHit.reduce((s, r) => s + r.hits, 0);
for (const c of chanHit) {
  console.log(`  ${c.channel}: ${c.hits} (${totalHits > 0 ? (c.hits/totalHits*100).toFixed(1) : "0"}%)`);
}

// 8. Hit rate by fragment age — does recall decay with age?
console.log("\n=== 按碎片年龄的召回频率 ===");
const ageBuckets = [
  { label: "0-1天", max: NOW - 1 * DAY },
  { label: "1-3天", max: NOW - 3 * DAY, min: NOW - 1 * DAY },
  { label: "3-7天", max: NOW - 7 * DAY, min: NOW - 3 * DAY },
  { label: "7-14天", max: NOW - 14 * DAY, min: NOW - 7 * DAY },
  { label: "14天+", min: 0, max: NOW - 14 * DAY },
];
for (const b of ageBuckets) {
  let sql: string;
  let row: { total: number; recalled: number };
  if (b.min != null) {
    sql = `SELECT COUNT(DISTINCT f.id) as total, SUM(CASE WHEN f.recalled_count > 0 THEN 1 ELSE 0 END) as recalled FROM fragments f WHERE f.project_id = ? AND f.created_at <= ? AND f.created_at > ? AND f.asset_state != 'user_deleted'`;
    row = db.prepare(sql).get(projectId, b.max, b.min) as { total: number; recalled: number };
  } else if (b.max != null) {
    sql = `SELECT COUNT(DISTINCT f.id) as total, SUM(CASE WHEN f.recalled_count > 0 THEN 1 ELSE 0 END) as recalled FROM fragments f WHERE f.project_id = ? AND f.created_at > ? AND f.asset_state != 'user_deleted'`;
    row = db.prepare(sql).get(projectId, b.max) as { total: number; recalled: number };
  } else {
    sql = `SELECT COUNT(DISTINCT f.id) as total, SUM(CASE WHEN f.recalled_count > 0 THEN 1 ELSE 0 END) as recalled FROM fragments f WHERE f.project_id = ? AND f.created_at <= ? AND f.asset_state != 'user_deleted'`;
    row = db.prepare(sql).get(projectId, b.max ?? 0) as { total: number; recalled: number };
  }
  const rate = row.total > 0 ? (row.recalled / row.total * 100).toFixed(1) : "0";
  console.log(`  ${b.label}: ${row.recalled}/${row.total} (${rate}%)`);
}

// 9. Distilled rule actual usage — are L0 rules being hit by prefetch?
console.log("\n=== 蒸馏规则使用频率 ===");
const ruleUsage = db.prepare(`
  SELECT DISTINCT dr.text, dr.weight, dr.priority,
    (SELECT COUNT(*) FROM rule_application_logs ral WHERE ral.rule_id = dr.id) as applied,
    (SELECT SUM(CASE WHEN ral.user_accepted = 1 THEN 1 ELSE 0 END) FROM rule_application_logs ral WHERE ral.rule_id = dr.id) as accepted
  FROM distilled_rules dr
  WHERE dr.superseded_by IS NULL
  ORDER BY dr.weight DESC LIMIT 10
`).all() as Array<{ text: string; weight: number; priority: number; applied: number; accepted: number }>;
for (const r of ruleUsage) {
  const tag = r.priority === 0 ? "[铁律]" : r.priority === 25 ? "[教训]" : "";
  console.log(`  ${tag}${r.text.slice(0, 50)} — 应用${r.applied}次 接受${r.accepted}次 (权重${r.weight.toFixed(2)})`);
}

// 10. self_reflect vs behavior signal distinction
console.log("\n=== 信号源统计 (近7天) ===");
const sigStats = db.prepare(`
  SELECT signal_type,
    COUNT(*) as total,
    SUM(CASE WHEN consumed = 1 THEN 1 ELSE 0 END) as consumed,
    AVG(weight) as avgWeight
  FROM lightweight_signals
  WHERE project_id = ? AND created_at > ?
  GROUP BY signal_type ORDER BY total DESC
`).all(projectId, NOW - 7 * DAY) as Array<{ signal_type: string; total: number; consumed: number; avgWeight: number }>;
const userSignals = ["correction", "frustration", "confirmation"];
for (const s of sigStats) {
  const source = s.signal_type === "self_reflect" ? "AI反思" : userSignals.includes(s.signal_type) ? "用户行为" : "其他";
  console.log(`  [${source}] ${s.signal_type}: ${s.total}条 消费${s.consumed} 均权${s.avgWeight.toFixed(0)}`);
}

console.log("\n提示: Phase 0A 四维基线就绪。定期运行追踪趋势。");
