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

console.log("\n提示: 定期运行此脚本追踪趋势。发布前目标: 综合分 > 70。");
