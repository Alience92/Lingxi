// SLM classification benchmark: compare small model vs LLM channel classifications
import { getDefaultModel, isOllamaRunning, pullModel } from "../smallmodel/index.js";
import { classifyChannel, recordComparison, getShadowStats } from "../smallmodel/classifier.js";
import { openDb, getDb } from "../db/connection.js";

const BENCHMARK_LIMIT = 200;

async function main() {
  const projectId = process.argv[2] || process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";

  console.error("[SLM Benchmark] Checking Ollama...");
  const running = await isOllamaRunning();
  if (!running) {
    console.error("Ollama is not running. Start it with: ollama serve");
    process.exit(1);
  }

  const targetModel = process.env.SMALLMODEL_NAME || "qwen2.5:0.5b";
  const model = await getDefaultModel();
  console.error(`[SLM Benchmark] Model: ${model}`);

  // If 0.5b not available, try to pull it; otherwise use whatever is available
  if (!model.includes("0.5b") && model.includes("7b")) {
    console.error(`[SLM Benchmark] Using ${model} (0.5b not found, pull with: ollama pull qwen2.5:0.5b)`);
  }

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
    console.error("No fragments found. Run memory_remember first.");
    process.exit(1);
  }

  console.error(`Running classification on ${fragments.length} fragments...\n`);

  let done = 0;
  for (const frag of fragments) {
    const slm = await classifyChannel(frag.summary);
    recordComparison(frag.summary, slm, { channel: frag.llm_channel });
    done++;
    if (done % 20 === 0) console.error(`  ${done}/${fragments.length}...`);
  }

  const stats = getShadowStats();

  console.log(JSON.stringify({
    model,
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
}

main().catch((e) => { console.error(e); process.exit(1); });
