// Few-shot channel classification benchmark (dev tool — requires Ollama)
// Retrieves similar labeled examples from training set, injects into prompt
// Not part of production path; used for offline comparison against encoder
import * as fs from "node:fs";
import { openDb, getDb } from "../dist/db/connection.js";

const VALID = new Set(["WHAT", "FEEL", "WHO", "WHERE"]);

function loadTrainingData() {
  const raw = fs.readFileSync("./tools/feel-training-dataset.jsonl", "utf-8");
  return raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

// Simple keyword-overlap retriever (fast, no embeddings needed)
function retrieveExamples(query, dataset, k = 5) {
  // Extract keywords from query
  const qWords = new Set(query.replace(/[，。！？、；：""''（）\s]+/g, "").split(""));
  const scored = dataset.map(item => {
    const iWords = new Set(item.text.replace(/[，。！？、；：""''（）\s]+/g, "").split(""));
    let overlap = 0;
    for (const w of qWords) if (iWords.has(w)) overlap++;
    return { ...item, score: overlap / Math.max(1, Math.sqrt(iWords.size)) };
  });
  scored.sort((a, b) => b.score - a.score);
  // Diversity: pick top examples with different labels
  const selected = [];
  const usedLabels = new Set();
  for (const s of scored) {
    if (selected.length >= k) break;
    if (!usedLabels.has(s.label) || selected.length >= k - 2) {
      selected.push(s);
      usedLabels.add(s.label);
    }
  }
  return selected;
}

function buildFewShotPrompt(text, examples) {
  const exampleBlock = examples.map(e =>
    `"${e.text.slice(0, 120)}" → ${e.label}`
  ).join("\n");

  return `分类通道(只输出WHAT/FEEL/WHO/WHERE中的一个):
WHAT=实质决策/方案/需求 FEEL=用户对AI的情绪反馈 WHO=涉及人物/角色 WHERE=文件/项目/工具

示例:
${exampleBlock}

"${text.slice(0, 300)}"
通道:`;
}

async function classifyFewShot(text, examples, classifyFn) {
  const prompt = buildFewShotPrompt(text, examples);
  return classifyFn(prompt);
}

async function main() {
  console.error("Loading training data...");
  const fullDataset = loadTrainingData();
  console.error(`Full dataset: ${fullDataset.length} samples`);

  openDb();
  const db = getDb();

  // Use same 40 fragments from last benchmark (created after 14:47 on 5/27)
  const frags = db.prepare(`
    SELECT f.id, f.summary,
      (SELECT fa2.channel FROM fragment_anchors fa2 WHERE fa2.fragment_id = f.id ORDER BY fa2.weight DESC LIMIT 1) as llm_channel
    FROM fragments f
    WHERE f.project_id = ? AND f.created_at > 1748335623000
    LIMIT 40
  `).all("C--Users-Administrator");

  // Exclude test fragments from retrieval pool to prevent data leakage
  const testIds = new Set(frags.map(f => f.id));
  const dataset = fullDataset.filter(item => {
    // Synthetic samples don't have fragment IDs
    return true;
  });
  // Also: remove any training sample whose text exactly matches a test fragment
  const testTexts = new Set(frags.map(f => f.summary));
  const cleanDataset = dataset.filter(item => !testTexts.has(item.text));
  const removed = dataset.length - cleanDataset.length;
  console.error(`Excluded ${removed} overlapping samples from retrieval pool`);
  console.error(`Clean dataset: ${cleanDataset.length} samples`);

  console.error(`Benchmarking on ${frags.length} fragments...\n`);

  // Use the Ollama classify function
  const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
  async function callOllama(prompt) {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.FEWSHOT_MODEL || "qwen2.5:7b",
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 8 },
      }),
    });
    const data = await res.json();
    const raw = (data.response ?? "").trim().toUpperCase();
    return VALID.has(raw) ? raw : "WHAT";
  }

  let matches = 0, totalLatency = 0;
  const perChannel = {};
  const mismatches = [];

  for (let i = 0; i < frags.length; i++) {
    const f = frags[i];
    const examples = retrieveExamples(f.summary, cleanDataset, 5);

    const t0 = Date.now();
    const slm = await callOllama(buildFewShotPrompt(f.summary, examples));
    const lat = Date.now() - t0;
    totalLatency += lat;

    const match = slm === f.llm_channel;
    if (match) matches++;

    const ch = f.llm_channel;
    if (!perChannel[ch]) perChannel[ch] = { correct: 0, total: 0 };
    perChannel[ch].total++;
    if (match) perChannel[ch].correct++;

    if (!match) mismatches.push({ summary: f.summary, llm: f.llm_channel, slm });

    console.error(`  ${(i + 1).toString().padStart(2)} | LLM: ${f.llm_channel} → SLM: ${slm} | ${match ? "✓" : "✗"} | ${lat}ms`);
  }

  console.log("\n=== Few-Shot (5 examples) ===");
  console.log(`Total: ${frags.length} | Match: ${(matches / frags.length * 100).toFixed(1)}% | Avg: ${(totalLatency / frags.length).toFixed(0)}ms`);
  for (const [ch, d] of Object.entries(perChannel)) {
    console.log(`  ${ch}: ${d.correct}/${d.total} (${(d.correct / d.total * 100).toFixed(0)}%)`);
  }

  if (mismatches.length > 0) {
    console.log("\nMismatches:");
    mismatches.slice(0, 10).forEach(m => console.log(`  LLM:${m.llm} → SLM:${m.slm} | ${m.summary?.slice(0, 80)}`));
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
