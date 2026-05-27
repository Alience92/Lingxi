// SLM classification benchmark: compare small model vs LLM channel classifications
import { loadModel, unloadModel } from "../smallmodel/index.js";
import { classifyChannel, recordComparison, getShadowStats } from "../smallmodel/classifier.js";
import { openDb, getDb } from "../db/connection.js";

const BENCHMARK_LIMIT = 200;

async function main() {
  const projectId = process.argv[2] || process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  console.error("[SLM Benchmark] Loading model...");
  const { context } = await loadModel();
  console.error("[SLM Benchmark] Model ready.\n");

  openDb();
  const db = getDb();

  // Get fragments with their LLM-assigned channels
  const fragments = db.prepare(`
    SELECT f.id, f.summary, fa.channel as llm_channel
    FROM fragments f
    JOIN fragment_anchors fa ON fa.fragment_id = f.id
    WHERE f.project_id = ? AND f.status = 'active'
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(projectId, BENCHMARK_LIMIT) as Array<{ id: string; summary: string; llm_channel: string }>;

  if (fragments.length === 0) {
    console.error("No fragments found. Run memory_remember first to populate fragments.");
    process.exit(1);
  }

  console.error(`Running classification on ${fragments.length} fragments...\n`);

  for (const frag of fragments) {
    const slm = await classifyChannel(frag.summary, context);
    recordComparison(frag.summary, slm, { channel: frag.llm_channel });
  }

  const stats = getShadowStats();

  console.log(JSON.stringify({
    total: stats.total,
    matchRate: stats.matchRate,
    matchRatePct: (stats.matchRate * 100).toFixed(1) + "%",
    avgLatencyMs: stats.avgLatencyMs.toFixed(1),
    channelAccuracy: Object.fromEntries(
      Object.entries(stats.channelAccuracy).map(([ch, acc]) => [
        ch,
        {
          correct: acc.correct,
          total: acc.total,
          rate: acc.total > 0 ? (acc.correct / acc.total * 100).toFixed(1) + "%" : "N/A",
        },
      ])
    ),
  }, null, 2));

  await unloadModel();
}

main().catch((e) => { console.error(e); process.exit(1); });
