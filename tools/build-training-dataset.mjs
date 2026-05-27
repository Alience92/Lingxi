// Build balanced 4-channel training dataset for LoRA fine-tuning
import * as fs from "node:fs";
import { openDb, getDb } from "../dist/db/connection.js";

const TARGET_PER_CHANNEL = 500;
const OUTPUT_PATH = "D:/Lingxi-v4/tools/feel-training-dataset.jsonl";

function deduplicate(texts) {
  const seen = new Set();
  const result = [];
  for (const t of texts) {
    const key = t.replace(/[，。！？、；：""''（）\s]+/g, "").toLowerCase().slice(0, 60);
    if (!seen.has(key) && t.length >= 6 && t.length <= 150) {
      seen.add(key);
      result.push(t);
    }
  }
  return result;
}

function main() {
  openDb();
  const db = getDb();
  const pid = "C--Users-Administrator";

  // Clear output file
  if (fs.existsSync(OUTPUT_PATH)) fs.unlinkSync(OUTPUT_PATH);

  // 1. SYNTHETIC FEEL samples
  let synthetic = [];
  try {
    synthetic = JSON.parse(fs.readFileSync("D:/Lingxi-v4/tools/synthetic-feel-samples.json", "utf-8"));
  } catch { console.error("No synthetic samples found"); }

  // 2. REAL FEEL from DB
  const realFeel = db.prepare(`
    SELECT DISTINCT f.summary FROM fragments f
    JOIN fragment_anchors fa ON fa.fragment_id = f.id
    WHERE f.project_id = @pid AND f.status = 'active' AND fa.channel = 'FEEL'
  `).all({ pid }).map(r => r.summary);

  // 3. Merge FEEL, deduplicate
  const allFeel = [...new Set([...synthetic, ...realFeel])];
  const dedupedFeel = deduplicate(allFeel);
  const finalFeel = dedupedFeel.slice(0, TARGET_PER_CHANNEL);

  // 4. WHAT / WHERE / WHO from DB
  const allLines = [];

  for (const channel of ["WHAT", "WHERE", "WHO"]) {
    const samples = db.prepare(`
      SELECT DISTINCT f.summary FROM fragments f
      JOIN fragment_anchors fa ON fa.fragment_id = f.id
      WHERE f.project_id = @pid AND f.status = 'active' AND fa.channel = @ch
      ORDER BY fa.weight DESC LIMIT ${TARGET_PER_CHANNEL * 2}
    `).all({ pid, ch: channel }).map(r => r.summary);

    const deduped = deduplicate(samples).slice(0, TARGET_PER_CHANNEL);
    deduped.forEach(text => allLines.push(JSON.stringify({ text, label: channel })));
    console.error(`${channel}: ${deduped.length} samples`);
  }

  // FEEL last
  finalFeel.forEach(text => allLines.push(JSON.stringify({ text, label: "FEEL" })));
  console.error(`FEEL: ${finalFeel.length} samples (${synthetic.length} synthetic + ${realFeel.length} real)`);

  // Shuffle
  for (let i = allLines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allLines[i], allLines[j]] = [allLines[j], allLines[i]];
  }

  fs.writeFileSync(OUTPUT_PATH, allLines.join("\n") + "\n", "utf-8");
  console.error(`\nTotal: ${allLines.length} samples → ${OUTPUT_PATH}`);

  // Distribution
  const dist = {};
  allLines.forEach(line => {
    const label = JSON.parse(line).label;
    dist[label] = (dist[label] || 0) + 1;
  });
  console.error("Distribution:", JSON.stringify(dist));
}

main();
