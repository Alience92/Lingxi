import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = path.resolve(__dirname, "../../benchmark-results/v7-memory-benchmark-zh.json");
const OUTPUT_DIR = path.resolve(__dirname, "../../benchmark-results");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "v7-memory-cend-report-zh.json");

interface EvalRow {
  id: number;
  query: string;
  top1Hit: boolean;
  top3Hit: boolean;
  top5Hit: boolean;
  latencyMs: number;
  firstRelevantRank: number | null;
}

interface BenchmarkResult {
  retrieval: {
    overall: {
      recallAt1: number;
      recallAt3: number;
      recallAt5: number;
      mrr: number;
      avgLatencyMs: number;
    };
    evaluations: EvalRow[];
  };
}

interface ExperienceSlice {
  name: string;
  ids: number[];
}

const SLICES: ExperienceSlice[] = [
  { name: "preference_continuity", ids: [31, 38, 73, 79, 82, 86, 89, 94, 95] },
  { name: "rule_reliability", ids: [34, 35, 57, 68, 69, 81, 84, 85, 90] },
  { name: "project_continuity", ids: [30, 39, 40, 41, 42, 74, 87, 98, 99, 100] },
  { name: "short_query_snap", ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 54, 55, 56, 57, 58, 59, 60] },
];

function summarize(rows: EvalRow[]): {
  total: number;
  top1: number;
  top3: number;
  top5: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
} {
  const sortedLatency = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const total = rows.length;
  const p95Index = Math.min(sortedLatency.length - 1, Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1));
  return {
    total,
    top1: total > 0 ? rows.filter((row) => row.top1Hit).length / total : 0,
    top3: total > 0 ? rows.filter((row) => row.top3Hit).length / total : 0,
    top5: total > 0 ? rows.filter((row) => row.top5Hit).length / total : 0,
    avgLatencyMs: total > 0 ? rows.reduce((sum, row) => sum + row.latencyMs, 0) / total : 0,
    p95LatencyMs: sortedLatency.length > 0 ? sortedLatency[p95Index]! : 0,
  };
}

function main(): void {
  const raw = fs.readFileSync(INPUT_PATH, "utf8");
  const benchmark = JSON.parse(raw) as BenchmarkResult;
  const evaluations = benchmark.retrieval.evaluations;

  const slices = Object.fromEntries(
    SLICES.map((slice) => {
      const rows = evaluations.filter((row) => slice.ids.includes(row.id));
      return [slice.name, summarize(rows)];
    }),
  );

  const fastEnoughRate = evaluations.filter((row) => row.latencyMs <= 50).length / Math.max(evaluations.length, 1);
  const instantRate = evaluations.filter((row) => row.latencyMs <= 20).length / Math.max(evaluations.length, 1);
  const perceivedRememberedRate = evaluations.filter((row) => row.top3Hit).length / Math.max(evaluations.length, 1);
  const wrongMemoryRiskRate = evaluations.filter((row) => row.firstRelevantRank === null || row.firstRelevantRank > 3).length / Math.max(evaluations.length, 1);

  const result = {
    source: INPUT_PATH,
    summary: {
      recallAt1: benchmark.retrieval.overall.recallAt1,
      recallAt3: benchmark.retrieval.overall.recallAt3,
      recallAt5: benchmark.retrieval.overall.recallAt5,
      mrr: benchmark.retrieval.overall.mrr,
      avgLatencyMs: benchmark.retrieval.overall.avgLatencyMs,
      perceivedRememberedRate,
      wrongMemoryRiskRate,
      fastEnoughRate,
      instantRate,
    },
    slices,
    interpretation: {
      preferenceContinuity: slices.preference_continuity.top1,
      ruleReliability: slices.rule_reliability.top1,
      projectContinuity: slices.project_continuity.top3,
      shortQueryResponsiveness: slices.short_query_snap.p95LatencyMs,
    },
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`C端评测已写入: ${OUTPUT_PATH}`);
  console.log(`perceivedRememberedRate=${(perceivedRememberedRate * 100).toFixed(1)}% wrongMemoryRiskRate=${(wrongMemoryRiskRate * 100).toFixed(1)}%`);
  console.log(`fastEnoughRate=${(fastEnoughRate * 100).toFixed(1)}% instantRate=${(instantRate * 100).toFixed(1)}%`);
  console.log(`preferenceTop1=${(slices.preference_continuity.top1 * 100).toFixed(1)}% ruleTop1=${(slices.rule_reliability.top1 * 100).toFixed(1)}% projectTop3=${(slices.project_continuity.top3 * 100).toFixed(1)}%`);
}

main();
