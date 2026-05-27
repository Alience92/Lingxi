// Fragmentation quality verification.
// Runs fragmentation 3x on each sample and measures consistency.
// Tests: count stability, channel distribution, label overlap, FEEL weight stability, fidelity.

import { fragmentTranscript } from "../core/fragmenter.js";
import * as fs from "node:fs";
import * as path from "node:path";

const RUNS = 3;

interface RunResult {
  fragmentCount: number;
  channels: Record<string, number>;
  labels: string[];
  feelWeights: Array<{ label: string; weight: number }>;
  summaries: string[];
  rawOutput: string;
}

function extractConversation(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const conversation: string[] = [];
  let count = 0;
  for (const line of lines) {
    if (count >= 50) break; // capture enough for FEEL signals
    try {
      const obj = JSON.parse(line);
      let text = "";
      if (obj.message?.content) {
        if (Array.isArray(obj.message.content)) {
          text = obj.message.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ");
        } else {
          text = String(obj.message.content);
        }
      }
      if (text.trim()) {
        const role = obj.type === "user" ? "User" : obj.type === "assistant" ? "Assistant" : obj.type;
        conversation.push(`${role}: ${text.slice(0, 800)}`);
        count++;
      }
    } catch {}
  }
  return conversation.join("\n");
}

function analyzeRun(output: { fragments: Array<{ anchors: Array<{ channel: string; label: string; weight: number }>; summary: string }> }): RunResult {
  const channels: Record<string, number> = {};
  const labels: string[] = [];
  const feelWeights: Array<{ label: string; weight: number }> = [];
  const summaries: string[] = [];

  for (const f of output.fragments) {
    for (const a of f.anchors) {
      channels[a.channel] = (channels[a.channel] || 0) + 1;
      labels.push(a.label);
      if (a.channel === "FEEL") {
        feelWeights.push({ label: a.label, weight: a.weight });
      }
    }
    summaries.push(f.summary);
  }

  return {
    fragmentCount: output.fragments.length,
    channels,
    labels,
    feelWeights,
    summaries,
    rawOutput: JSON.stringify(output.fragments.map(f => f.summary)),
  };
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 1 : intersection.size / union.size;
}

function cosineTextSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const denom = Math.sqrt(wordsA.size) * Math.sqrt(wordsB.size);
  return denom === 0 ? 0 : intersection.size / denom;
}

function loadSettingsEnv(): Record<string, string> {
  const settingsPaths = [
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.json`,
    `${process.env.HOME || process.env.USERPROFILE}/.claude/settings.local.json`,
  ];
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const p of settingsPaths) {
    try {
      const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (obj.env) Object.assign(env, obj.env);
    } catch {}
  }
  return env;
}

async function main() {
  const settingsEnv = loadSettingsEnv();
  const apiKey = settingsEnv.DEEPSEEK_API_KEY || settingsEnv.ANTHROPIC_AUTH_TOKEN || "";
  const baseURL = settingsEnv.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const projectId = "C--Users-Administrator";
  const workspaceDir = `${process.env.HOME || process.env.USERPROFILE}/.claude/projects/${projectId}`;

  if (!apiKey || apiKey.length <= 10) {
    console.error("No valid API key found.");
    process.exit(1);
  }

  // Accept --session or --text for inline testing
  const sessionArg = process.argv.find(a => a.startsWith("--session="))?.split("=")[1];
  const textArg = process.argv.find(a => a.startsWith("--text="))?.split("=").slice(1).join("=");
  let samples: Array<{ name: string; path: string; size: number; transcript?: string }>;

  if (textArg) {
    samples = [{ name: "inline-test", path: "", size: textArg.length, transcript: textArg }];
  } else if (sessionArg) {
    const p = path.join(workspaceDir, sessionArg.endsWith(".jsonl") ? sessionArg : sessionArg + ".jsonl");
    if (!fs.existsSync(p)) { console.error("Session not found:", p); process.exit(1); }
    samples = [{ name: path.basename(p), path: p, size: fs.statSync(p).size }];
  } else {
    const files = fs.readdirSync(workspaceDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({ name: f, path: path.join(workspaceDir, f), size: fs.statSync(path.join(workspaceDir, f)).size }))
      .filter(f => f.size > 100000 && f.size < 3000000)
      .sort((a, b) => a.size - b.size);
    samples = [files[0]!, files[Math.floor(files.length / 2)]!];
  }

  console.log("=== Fragmentation Quality Verification ===\n");
  console.log(`Running ${RUNS}x fragmentation on ${samples.length} samples...\n`);

  let overallScore = 0;
  let testCount = 0;

  for (const sample of samples) {
    const transcript = sample.transcript || extractConversation(sample.path);
    console.log(`\n--- Sample: ${sample.name} (${(sample.size / 1024).toFixed(0)}KB, ${(transcript.length / 1000).toFixed(0)}K chars) ---`);

    const results: RunResult[] = [];
    for (let r = 0; r < RUNS; r++) {
      const { output } = await fragmentTranscript(
        { transcript, sessionId: `quality-${sample.name.slice(0, 8)}-r${r}`, projectId },
        apiKey, "deepseek-v4-pro", baseURL
      );
      results.push(analyzeRun(output));
      console.log(`  Run ${r + 1}: ${output.fragments.length} fragments`);
    }

    // 1. Fragment count stability
    const counts = results.map(r => r.fragmentCount);
    const avgCount = counts.reduce((s, c) => s + c, 0) / counts.length;
    const countVariance = counts.reduce((s, c) => s + (c - avgCount) ** 2, 0) / counts.length;
    const countCV = Math.sqrt(countVariance) / Math.max(1, avgCount); // coefficient of variation
    console.log(`\n  Count stability: avg=${avgCount.toFixed(1)}, CV=${(countCV * 100).toFixed(0)}% (target < 20%)`);
    if (countCV < 0.2) overallScore++;

    // 2. Channel distribution consistency
    const allChannels = new Set<string>();
    for (const r of results) Object.keys(r.channels).forEach(c => allChannels.add(c));
    let channelScore = 0;
    for (const ch of allChannels) {
      const chCounts = results.map(r => r.channels[ch] || 0);
      const chAvg = chCounts.reduce((s, c) => s + c, 0) / chCounts.length;
      const chCV = chAvg > 0 ? Math.sqrt(chCounts.reduce((s, c) => s + (c - chAvg) ** 2, 0) / chCounts.length) / chAvg : 0;
      if (chAvg > 0) channelScore += (1 - Math.min(1, chCV));
    }
    const channelConsistency = channelScore / Math.max(1, allChannels.size);
    console.log(`  Channel consistency: ${(channelConsistency * 100).toFixed(0)}% (target > 70%)`);
    if (channelConsistency > 0.7) overallScore++;
    console.log(`  Channel distribution:`, results.map(r => r.channels));

    // 3. Label overlap (pairwise Jaccard)
    let labelOverlap = 0;
    let pairCount = 0;
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        labelOverlap += jaccardSimilarity(results[i]!.labels, results[j]!.labels);
        pairCount++;
      }
    }
    const avgOverlap = labelOverlap / Math.max(1, pairCount);
    console.log(`  Label overlap (Jaccard): ${(avgOverlap * 100).toFixed(0)}% (target > 50%)`);
    if (avgOverlap > 0.5) overallScore++;

    // 4. FEEL weight consistency
    const allFeelLabels = new Set<string>();
    for (const r of results) r.feelWeights.forEach(f => allFeelLabels.add(f.label));
    if (allFeelLabels.size > 0) {
      let feelMatch = 0;
      let feelTotal = 0;
      for (const label of allFeelLabels) {
        const weights = results.map(r => {
          const fw = r.feelWeights.find(f => f.label === label);
          return fw ? fw.weight : -1;
        });
        const validWeights = weights.filter(w => w >= 0);
        if (validWeights.length >= 2) {
          const wAvg = validWeights.reduce((s, w) => s + w, 0) / validWeights.length;
          const maxDev = Math.max(...validWeights.map(w => Math.abs(w - wAvg)));
          if (maxDev <= 20) feelMatch++; // within 20 weight points = consistent
          feelTotal++;
        }
      }
      const feelConsistency = feelMatch / Math.max(1, feelTotal);
      console.log(`  FEEL weight consistency: ${(feelConsistency * 100).toFixed(0)}% (target > 60%)`);
      if (feelConsistency > 0.6) overallScore++;
      console.log(`  FEEL fragments:`, results.map(r => `${r.feelWeights.length} (${r.feelWeights.map(f => `${f.label.slice(0, 20)}:${f.weight}`).join(", ")})`));
    }

    testCount += 4;

    // 5. Fidelity: can a summary reconstruct the gist?
    const summarySet = new Set(results.flatMap(r => r.summaries));
    console.log(`  Unique summaries: ${summarySet.size}/${results.reduce((s, r) => s + r.summaries.length, 0)} total`);
    console.log(`  Sample summaries:`, [...summarySet].slice(0, 5));
  }

  console.log(`\n========================================`);
  console.log(`Overall quality score: ${overallScore}/${testCount} (${(overallScore / testCount * 100).toFixed(0)}%)`);
  if (overallScore / testCount >= 0.8) {
    console.log("Verdict: PASS — fragmentation quality is stable.");
  } else if (overallScore / testCount >= 0.6) {
    console.log("Verdict: MARGINAL — acceptable but needs monitoring.");
  } else {
    console.log("Verdict: FAIL — fragmentation quality is unstable, needs prompt/model tuning.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
