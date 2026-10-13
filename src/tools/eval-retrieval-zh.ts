import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_MEMORIES_ZH,
  BENCHMARK_QUERIES_ZH,
  type BenchmarkMemory,
  type BenchmarkQuery,
} from "./eval-retrieval-dataset-zh.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_HOME = path.resolve(__dirname, "../../.bench/lingxi-v7-memory-zh");
const DB_PATH = path.join(BENCH_HOME, "memory.db");
const OUTPUT_DIR = path.resolve(__dirname, "../../benchmark-results");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "v7-memory-benchmark-zh.json");
const PROJECT_ID = "C--Users-Administrator";
const PROFILE_ID = "benchmark_profile";

process.env.LINGXI_HOME = BENCH_HOME;
process.env.LINGXI_PROJECT_ID = PROJECT_ID;
process.env.LINGXI_PROFILE_ID = PROFILE_ID;

import { openDb } from "../db/connection.js";
import { recordFragment, getRawEvidence, runMaintenanceCycle } from "../core/state-gate.js";
import { initGraph } from "../core/dcgk-engine.js";
import { buildGraph, getGraphStats } from "../core/char-graph.js";
import { recallFromCognitiveGraph } from "../core/memory-recall.js";
import { updateActiveContext } from "../core/active-context.js";
import { getMemoryHealth } from "../core/health.js";
import { buildVectorIndex, getIndexStats } from "../core/fragment-vector-index.js";

interface QueryEvaluation {
  id: number;
  category: BenchmarkQuery["category"];
  query: string;
  top1Hit: boolean;
  top3Hit: boolean;
  top5Hit: boolean;
  reciprocalRank: number;
  firstRelevantRank: number | null;
  latencyMs: number;
  topSource: string | null;
  matchedKey: string | null;
  results: Array<{ rank: number; key: string | null; source: string; score: number }>;
}

interface CategoryMetrics {
  total: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  avgLatencyMs: number;
}

function resetBenchmarkDb(): void {
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

function seedMemories(memories: BenchmarkMemory[]): Map<string, string> {
  const db = openDb(DB_PATH);
  const ids = new Map<string, string>();
  for (const memory of memories) {
    const id = recordFragment({
      sessionId: "benchmark_session",
      projectId: PROJECT_ID,
      profileId: PROFILE_ID,
      summary: memory.summary,
      keywords: memory.keywords,
      rawText: memory.rawText,
      rawPrefix: memory.rawText.slice(0, 80),
    }, "eval-retrieval-zh");
    ids.set(memory.key, id);
    if (memory.subtype) {
      db.prepare("UPDATE fragments SET subtype = ? WHERE id = ?").run(memory.subtype, id);
    }
  }
  return ids;
}

function mapSummaryToKey(memories: BenchmarkMemory[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const memory of memories) {
    map.set(memory.summary, memory.key);
  }
  return map;
}

function computeCategoryMetrics(rows: QueryEvaluation[]): CategoryMetrics {
  const total = rows.length;
  const sum = <T>(fn: (row: QueryEvaluation) => number): number => rows.reduce((acc, row) => acc + fn(row), 0);
  return {
    total,
    recallAt1: total > 0 ? sum((r) => (r.top1Hit ? 1 : 0)) / total : 0,
    recallAt3: total > 0 ? sum((r) => (r.top3Hit ? 1 : 0)) / total : 0,
    recallAt5: total > 0 ? sum((r) => (r.top5Hit ? 1 : 0)) / total : 0,
    mrr: total > 0 ? sum((r) => r.reciprocalRank) / total : 0,
    avgLatencyMs: total > 0 ? sum((r) => r.latencyMs) / total : 0,
  };
}

async function evaluateQueries(queries: BenchmarkQuery[], summaryToKey: Map<string, string>): Promise<QueryEvaluation[]> {
  const rows: QueryEvaluation[] = [];
  for (const query of queries) {
    const t0 = Date.now();
    const results = await recallFromCognitiveGraph(query.query, 5);
    const latencyMs = Date.now() - t0;

    let firstRelevantRank: number | null = null;
    const normalized = results.map((result, index) => {
      const key = summaryToKey.get(result.content) ?? null;
      if (firstRelevantRank === null && key && query.expectedKeys.includes(key)) {
        firstRelevantRank = index + 1;
      }
      return {
        rank: index + 1,
        key,
        source: result.source,
        score: result.score,
      };
    });

    rows.push({
      id: query.id,
      category: query.category,
      query: query.query,
      top1Hit: firstRelevantRank === 1,
      top3Hit: firstRelevantRank !== null && firstRelevantRank <= 3,
      top5Hit: firstRelevantRank !== null && firstRelevantRank <= 5,
      reciprocalRank: firstRelevantRank ? 1 / firstRelevantRank : 0,
      firstRelevantRank,
      latencyMs,
      topSource: normalized[0]?.source ?? null,
      matchedKey: firstRelevantRank ? normalized[firstRelevantRank - 1]?.key ?? null : null,
      results: normalized,
    });
  }
  return rows;
}

function collectActiveContextSummary(): { decisions: number; todos: number; preferences: number; hasCare: boolean; hasAlerts: boolean } {
  const db = openDb(DB_PATH);
  updateActiveContext(PROJECT_ID);
  const row = db.prepare("SELECT active_context FROM projects WHERE id = ?").get(PROJECT_ID) as { active_context: string | null } | undefined;
  if (!row?.active_context) {
    return { decisions: 0, todos: 0, preferences: 0, hasCare: false, hasAlerts: false };
  }
  const parsed = JSON.parse(row.active_context) as {
    decisions?: unknown[];
    todos?: unknown[];
    preferences?: unknown[];
    care?: unknown;
    alerts?: unknown[];
  };
  return {
    decisions: parsed.decisions?.length ?? 0,
    todos: parsed.todos?.length ?? 0,
    preferences: parsed.preferences?.length ?? 0,
    hasCare: Boolean(parsed.care),
    hasAlerts: Boolean(parsed.alerts && parsed.alerts.length > 0),
  };
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  灵犀 V7 纯中文记忆评测基线");
  console.log("=".repeat(60));

  resetBenchmarkDb();
  ensureProjectRow();
  const fragmentIds = seedMemories(BENCHMARK_MEMORIES_ZH);
  const summaryToKey = mapSummaryToKey(BENCHMARK_MEMORIES_ZH);

  initGraph();
  const graphStats = buildGraph(PROJECT_ID);

  let vectorIndexAvailable = false;
  let vectorIndexError: string | null = null;
  try {
    const vectorStats = await buildVectorIndex(PROJECT_ID);
    vectorIndexAvailable = vectorStats.entryCount > 0;
  } catch (error: unknown) {
    vectorIndexError = error instanceof Error ? error.message : String(error);
  }

  const evaluations = await evaluateQueries(BENCHMARK_QUERIES_ZH, summaryToKey);
  const byCategory = new Map<BenchmarkQuery["category"], QueryEvaluation[]>();
  for (const row of evaluations) {
    const bucket = byCategory.get(row.category) ?? [];
    bucket.push(row);
    byCategory.set(row.category, bucket);
  }

  const overall = computeCategoryMetrics(evaluations);
  const categories = Object.fromEntries(
    [...byCategory.entries()].map(([category, rows]) => [category, computeCategoryMetrics(rows)]),
  );

  const routeDistribution = evaluations.reduce<Record<string, number>>((acc, row) => {
    const key = row.topSource ?? "none";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  let rawEvidenceHits = 0;
  for (const fragmentId of fragmentIds.values()) {
    const evidence = getRawEvidence(fragmentId);
    if (evidence && evidence.length > 0) rawEvidenceHits++;
  }

  const activeContext = collectActiveContextSummary();
  const health = getMemoryHealth(PROJECT_ID);
  const maintenance = await runMaintenanceCycle("eval-retrieval-zh");

  const result = {
    benchmark: {
      projectId: PROJECT_ID,
      databasePath: DB_PATH,
      memoryCount: BENCHMARK_MEMORIES_ZH.length,
      queryCount: BENCHMARK_QUERIES_ZH.length,
      locale: "zh-CN",
    },
    buildChecks: {
      charGraph: graphStats,
      graphStats: getGraphStats(),
      vectorIndexAvailable,
      vectorIndexStats: getIndexStats(),
      vectorIndexError,
    },
    retrieval: {
      overall,
      categories,
      routeDistribution,
      top1ErrorRate: 1 - overall.recallAt1,
      zeroHitRate: evaluations.filter((row) => row.firstRelevantRank === null).length / evaluations.length,
      evaluations,
    },
    functionalChecks: {
      rawEvidenceHitRate: rawEvidenceHits / fragmentIds.size,
      activeContext,
      health,
      maintenance,
    },
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));

  console.log(`\n数据库: ${DB_PATH}`);
  console.log(`记忆数: ${BENCHMARK_MEMORIES_ZH.length} | Query数: ${BENCHMARK_QUERIES_ZH.length}`);
  console.log(`Recall@1=${overall.recallAt1.toFixed(3)} Recall@3=${overall.recallAt3.toFixed(3)} Recall@5=${overall.recallAt5.toFixed(3)} MRR=${overall.mrr.toFixed(3)}`);
  console.log(`平均延迟=${overall.avgLatencyMs.toFixed(1)}ms`);
  console.log(`路由分布: ${JSON.stringify(routeDistribution)}`);
  console.log(`rawEvidence命中率: ${(result.functionalChecks.rawEvidenceHitRate * 100).toFixed(1)}%`);
  console.log(`active_context: decisions=${activeContext.decisions} todos=${activeContext.todos} preferences=${activeContext.preferences}`);
  console.log(`maintenance errors=${maintenance.errors.length}`);
  console.log(`\n结果已写入: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("评测失败:", error);
  process.exitCode = 1;
});
