// Token cost measurement for fragmentation.
// Tests 3 transcript sizes (short/medium/long) and reports
// token usage + cost estimates for server-mode fragmentation.

import { fragmentTranscript } from "../core/fragmenter.js";
import * as fs from "node:fs";
import * as path from "node:path";

const DEEPSEEK_PRICING = {
  promptPerM: 0.27,    // $0.27 per 1M input tokens (deepseek-chat)
  completionPerM: 1.10, // $1.10 per 1M output tokens
};

interface MeasureResult {
  file: string;
  fileSizeMB: number;
  transcriptChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD: number;
  fragments: number;
  durationMs: number;
}

function extractConversation(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const conversation: string[] = [];
  for (const line of lines) {
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
      }
    } catch {}
  }
  return conversation;
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

async function measureOne(
  apiKey: string,
  model: string,
  baseURL: string,
  filePath: string,
  sessionId: string,
  projectId: string
): Promise<MeasureResult> {
  const conversation = extractConversation(filePath);
  const fullTranscript = conversation.join("\n");
  const charsPerChunk = 30000;
  const chunks: string[] = [];
  let pos = 0;
  while (pos < fullTranscript.length) {
    chunks.push(fullTranscript.slice(pos, pos + charsPerChunk));
    pos += charsPerChunk;
  }

  const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalFragments = 0;
  const t0 = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    try {
      const result = await fragmentTranscript(
        { transcript: chunks[i]!, sessionId: chunks.length > 1 ? `${sessionId}__chunk${i}` : sessionId, projectId },
        apiKey, model, baseURL
      );

      if (result.usage) {
        totalPromptTokens += result.usage.promptTokens;
        totalCompletionTokens += result.usage.completionTokens;
      }
      totalFragments += result.output.fragments.length;
    } catch (e) {
      console.error(`  Chunk ${i + 1}/${chunks.length} failed:`, (e as Error).message?.slice(0, 60));
    }
  }

  const durationMs = Date.now() - t0;
  const totalTokens = totalPromptTokens + totalCompletionTokens;
  const costUSD = (totalPromptTokens / 1_000_000) * DEEPSEEK_PRICING.promptPerM +
                  (totalCompletionTokens / 1_000_000) * DEEPSEEK_PRICING.completionPerM;

  return {
    file: path.basename(filePath),
    fileSizeMB: Math.round(fileSizeMB * 100) / 100,
    transcriptChars: fullTranscript.length,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    totalTokens,
    costUSD: Math.round(costUSD * 10000) / 10000,
    fragments: totalFragments,
    durationMs,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const projectId = args.find(a => a.startsWith("--project="))?.split("=")[1] || "C--Users-Administrator";
  const workspaceDir = args.find(a => a.startsWith("--workspace="))?.split("=")[1] ||
    `${process.env.HOME || process.env.USERPROFILE}/.claude/projects/${projectId}`;

  const settingsEnv = loadSettingsEnv();
  const fragmentationKey = settingsEnv.DEEPSEEK_API_KEY || settingsEnv.ANTHROPIC_AUTH_TOKEN || "";
  const fragmentationBaseURL = settingsEnv.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

  if (!fragmentationKey || fragmentationKey.length <= 10) {
    console.error("No valid fragmentation API key found.");
    process.exit(1);
  }

  const model = "deepseek-chat";

  // Pick 3 representative files
  const allFiles = fs.readdirSync(workspaceDir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({ name: f, path: path.join(workspaceDir, f), size: fs.statSync(path.join(workspaceDir, f)).size }))
    .sort((a, b) => a.size - b.size);

  // Select: smallest, median, largest (but skip the 119MB extreme)
  const candidates = allFiles.filter(f => f.size < 50 * 1024 * 1024); // skip > 50MB
  const samples = [
    candidates[0]!,                          // shortest
    candidates[Math.floor(candidates.length / 2)]!, // median
    candidates[candidates.length - 1]!,      // longest
  ];

  console.log("=== Token Cost Measurement ===\n");
  console.log(`Pricing: DeepSeek chat — $${DEEPSEEK_PRICING.promptPerM}/M input, $${DEEPSEEK_PRICING.completionPerM}/M output\n`);

  const results: MeasureResult[] = [];
  for (const sample of samples) {
    console.log(`Measuring: ${sample.name} (${(sample.size / 1024 / 1024).toFixed(1)} MB)...`);
    const result = await measureOne(
      fragmentationKey, model, fragmentationBaseURL,
      sample.path,
      `measure-${sample.name.replace(".jsonl", "").slice(0, 8)}`,
      projectId
    );
    results.push(result);
    console.log(`  Transcript: ${(result.transcriptChars / 1000).toFixed(0)}K chars`);
    console.log(`  Tokens: ${result.promptTokens} prompt + ${result.completionTokens} completion = ${result.totalTokens} total`);
    console.log(`  Cost: $${result.costUSD.toFixed(4)}`);
    console.log(`  Fragments: ${result.fragments}`);
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Efficiency: ${result.fragments > 0 ? (result.totalTokens / result.fragments).toFixed(0) : 'N/A'} tokens/fragment\n`);
  }

  // Summary
  console.log("=== Summary ===");
  console.log("");
  console.log("| File | Size | Chars | Tokens | Cost | Frags | Time | Tok/Frag |");
  console.log("|------|------|-------|--------|------|-------|------|----------|");
  for (const r of results) {
    console.log(`| ${r.file.slice(0, 20)} | ${r.fileSizeMB}MB | ${(r.transcriptChars / 1000).toFixed(0)}K | ${r.totalTokens} | $${r.costUSD.toFixed(4)} | ${r.fragments} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.fragments > 0 ? (r.totalTokens / r.fragments).toFixed(0) : '-'} |`);
  }
  console.log("");

  const totalCost = results.reduce((s, r) => s + r.costUSD, 0);
  const avgTokensPer1KChars = results.reduce((s, r) => s + r.totalTokens / (r.transcriptChars / 1000), 0) / results.length;
  console.log(`Total cost (3 samples): $${totalCost.toFixed(4)}`);
  console.log(`Avg tokens per 1K transcript chars: ${avgTokensPer1KChars.toFixed(0)}`);
  console.log(`Estimated cost for a full workday session (~50K chars): $${(50 * avgTokensPer1KChars / 1_000_000 * (DEEPSEEK_PRICING.promptPerM + DEEPSEEK_PRICING.completionPerM) / 2).toFixed(4)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
