// Build 300-sample test set (75 per channel) from DB + synthetic pool + LLM generation
import * as fs from "fs";
import { openDb, getDb } from "../dist/db/connection.js";

function key(s) {
  return s.replace(/[，。！？、；：""''（）\s]+/g, "").slice(0, 80);
}

function main() {
  openDb();
  const db = getDb();
  const pid = "C--Users-Administrator";

  // Load training keys for exclusion
  const trainKeys = new Set();
  const trainLines = fs.readFileSync("./tools/feel-training-dataset.jsonl", "utf-8").split("\n").filter(Boolean);
  trainLines.forEach(l => { try { trainKeys.add(key(JSON.parse(l).text)); } catch {} });
  console.log("Training keys:", trainKeys.size);

  // Load synthetic FEEL pool
  const synthPool = JSON.parse(fs.readFileSync("./tools/synthetic-feel-samples.json", "utf-8"));

  const testSet = [];

  // WHAT: 75 from DB
  const whatRows = db.prepare(`
    SELECT DISTINCT f.summary FROM fragments f
    JOIN fragment_anchors fa ON fa.fragment_id = f.id
    WHERE f.project_id = @pid AND f.status = 'active' AND fa.channel = 'WHAT'
    ORDER BY fa.weight DESC LIMIT 800
  `).all({ pid });
  whatRows.filter(r => !trainKeys.has(key(r.summary)))
    .slice(0, 75)
    .forEach(r => testSet.push({ text: r.summary, label: "WHAT" }));

  // FEEL: 30 from DB + 45 from synthetic pool
  const feelRows = db.prepare(`
    SELECT DISTINCT f.summary FROM fragments f
    JOIN fragment_anchors fa ON fa.fragment_id = f.id
    WHERE f.project_id = @pid AND f.status = 'active' AND fa.channel = 'FEEL'
    ORDER BY fa.weight DESC
  `).all({ pid });
  const feelNew = feelRows.filter(r => !trainKeys.has(key(r.summary)));
  feelNew.slice(0, 30).forEach(r => testSet.push({ text: r.summary, label: "FEEL" }));

  const synthNew = synthPool.filter(s => !trainKeys.has(key(s)));
  synthNew.slice(0, 45).forEach(s => testSet.push({ text: s, label: "FEEL" }));

  // WHERE: from DB (likely 0 new)
  const whereRows = db.prepare(`
    SELECT DISTINCT f.summary FROM fragments f
    JOIN fragment_anchors fa ON fa.fragment_id = f.id
    WHERE f.project_id = @pid AND f.status = 'active' AND fa.channel = 'WHERE'
    ORDER BY fa.weight DESC
  `).all({ pid });
  whereRows.filter(r => !trainKeys.has(key(r.summary)))
    .forEach(r => testSet.push({ text: r.summary, label: "WHERE" }));

  // WHO: from DB (likely 0 new)
  const whoRows = db.prepare(`
    SELECT DISTINCT f.summary FROM fragments f
    JOIN fragment_anchors fa ON fa.fragment_id = f.id
    WHERE f.project_id = @pid AND f.status = 'active' AND fa.channel = 'WHO'
    ORDER BY fa.weight DESC
  `).all({ pid });
  whoRows.filter(r => !trainKeys.has(key(r.summary)))
    .forEach(r => testSet.push({ text: r.summary, label: "WHO" }));

  // Stats
  const dist = {};
  testSet.forEach(x => dist[x.label] = (dist[x.label] || 0) + 1);
  console.log("Partial test set:", testSet.length, JSON.stringify(dist));

  const gaps = {
    WHAT: Math.max(0, 75 - (dist["WHAT"] || 0)),
    FEEL: Math.max(0, 75 - (dist["FEEL"] || 0)),
    WHERE: Math.max(0, 75 - (dist["WHERE"] || 0)),
    WHO: Math.max(0, 75 - (dist["WHO"] || 0)),
  };
  console.log("Gaps to fill:", JSON.stringify(gaps));

  fs.writeFileSync("./tools/test-set-partial.json", JSON.stringify(testSet, null, 2), "utf-8");
  console.log("Saved to tools/test-set-partial.json");

  // Output gaps as JSON for the generation script
  console.log("\nGAPS_JSON:", JSON.stringify(gaps));
}

main();
