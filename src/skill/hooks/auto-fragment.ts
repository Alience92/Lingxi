// Standalone background worker for auto-fragmentation.
// Spawned by SessionStart hook; runs detached so the user never waits on it.

import { openDb, getDb } from "../../db/connection.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PER_SESSION_TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_CHARS = 30_000;
const DREAMING_THRESHOLD = 100;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function chunkConversation(conversation: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const msg of conversation) {
    if (currentLen + msg.length > maxChars && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
      currentLen = 0;
    }
    current.push(msg);
    currentLen += msg.length;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function fragmentOneSession(
  engine: any,
  sessionId: string,
  projectId: string,
  filePath: string
): Promise<number> {
  const conversation = extractConversation(filePath);
  if (conversation.length === 0) return 0;

  const fullTranscript = conversation.join("\n");
  if (fullTranscript.length < 200) return 0;

  const chunks = chunkConversation(conversation, MAX_TRANSCRIPT_CHARS);
  let totalFragments = 0;
  let anyChunkFailed = false;

  for (let i = 0; i < chunks.length; i++) {
    try {
      const result: unknown = await withTimeout(
        engine.fragmentSession({
          sessionId: chunks.length > 1 ? `${sessionId}__chunk${i}` : sessionId,
          projectId,
          transcript: chunks[i]!,
        }),
        PER_SESSION_TIMEOUT_MS
      );
      const frags = result as Array<{ id: string }>;
      totalFragments += frags.length;
    } catch (e) {
      anyChunkFailed = true;
    }
  }

  // Fallback: if any chunk failed and transcript is non-trivial,
  // attempt a single unfragmented pass to avoid losing content.
  if (anyChunkFailed && conversation.length >= 5 && totalFragments === 0) {
    try {
      const fallback = await withTimeout(
        engine.fragmentSession({
          sessionId,
          projectId,
          transcript: fullTranscript,
        }),
        PER_SESSION_TIMEOUT_MS
      );
      totalFragments += (fallback as Array<{ id: string }>).length;
    } catch {}
  }

  return totalFragments;
}

async function main() {
  const args = process.argv.slice(2);
  const projectId = args.find(a => a.startsWith("--project="))?.split("=")[1] || "claude-auto-memory";
  const sessionIdsArg = args.find(a => a.startsWith("--sessions="))?.split("=")[1] || "";
  const sessionIds = sessionIdsArg.split(",").filter(Boolean);

  if (sessionIds.length === 0) process.exit(0);

  openDb();
  const db = getDb();

  // Load settings & init engine
  const settingsEnv = loadSettingsEnv();
  const apiKey = settingsEnv.AGENTMEMORY_API_KEY || "";
  const fragmentationKey = settingsEnv.DEEPSEEK_API_KEY || settingsEnv.ANTHROPIC_AUTH_TOKEN || apiKey;
  const embeddingBaseURL = settingsEnv.AGENTMEMORY_EMBEDDING_URL || "https://api.minimax.chat";
  const fragmentationBaseURL = settingsEnv.DEEPSEEK_BASE_URL
    || (settingsEnv.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "https://api.minimax.chat");

  let engine: any = null;
  if (fragmentationKey && fragmentationKey.length > 10 && fragmentationKey !== "test-key") {
    try {
      const { MemoryEngine } = await import("../engine.js");
      engine = new MemoryEngine({
        apiKey,
        fragmentationKey,
        fragmentationBaseURL,
        baseURL: embeddingBaseURL,
      });
    } catch (e) {
      console.error(`[AgentMemory] auto-fragment worker: engine init failed:`, (e as Error).message?.slice(0, 80));
      process.exit(1);
    }
  }

  if (!engine) process.exit(0);

  // Resolve workspace dir + dreaming state
  let workspaceDir = "";
  let lastDreamingAt = 0;
  const project = db.prepare("SELECT workspace_dir, last_dreaming_at FROM projects WHERE id = ?").get(projectId) as { workspace_dir: string; last_dreaming_at: number | null } | undefined;
  workspaceDir = project?.workspace_dir || "";
  lastDreamingAt = project?.last_dreaming_at ?? 0;

  if (!workspaceDir || !fs.existsSync(workspaceDir)) {
    const inferred = path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".claude", "projects", projectId
    );
    if (fs.existsSync(inferred)) {
      workspaceDir = inferred;
      db.prepare("UPDATE projects SET workspace_dir = ? WHERE id = ?").run(workspaceDir, projectId);
    }
  }

  if (!workspaceDir || !fs.existsSync(workspaceDir)) process.exit(0);

  let totalFragments = 0;
  let processed = 0;

  for (const sessionId of sessionIds) {
    try {
      const jsonlPath = path.join(workspaceDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(jsonlPath)) {
        continue;
      }

      const count = await fragmentOneSession(engine, sessionId, projectId, jsonlPath);
      if (count > 0) {
        totalFragments += count;
        processed++;
      }
    } catch (e) {
      console.error(`[AgentMemory] auto-fragment: session ${sessionId.slice(0, 8)} failed:`, (e as Error).message?.slice(0, 80));
    } finally {
      db.prepare(`UPDATE sessions SET pending_fragmentation = 0, fragmented_at = ? WHERE id = ?`).run(Date.now(), sessionId);
    }
  }

  if (processed > 0) {
    console.error(`[AgentMemory] 后台碎片化完成: ${processed} 个会话 → ${totalFragments} 条新碎片`);
  }

  // Update active context with newly tagged fragments
  if (totalFragments > 0) {
    try {
      engine.updateActiveContext(projectId);
    } catch (e) {
      console.error(`[AgentMemory] 活跃上下文更新失败: ${(e as Error).message?.slice(0, 80)}`);
    }
  }

  // Shadow mode: SLM vs LLM channel classification comparison
  if (totalFragments > 0) {
    try {
      const { classifyChannel, recordComparison } = await import("../../smallmodel/classifier.js");
      const { isOllamaRunning, getDefaultModel } = await import("../../smallmodel/index.js");
      const ollamaUp = await isOllamaRunning();

      if (ollamaUp) {
        const slmModel = await getDefaultModel();
        // Build LIKE clauses to catch chunked sessions (sessionId__chunkN)
        const chunkClauses = sessionIds.map(() => "(f.session_id = ? OR f.session_id LIKE ? || '__chunk%')").join(" OR ");
        const chunkParams: string[] = [];
        for (const sid of sessionIds) { chunkParams.push(sid, sid); }

        const recentFrags = db.prepare(`
          SELECT f.id, f.summary,
            (SELECT fa2.channel FROM fragment_anchors fa2 WHERE fa2.fragment_id = f.id ORDER BY fa2.weight DESC LIMIT 1) as llm_channel
          FROM fragments f
          WHERE f.project_id = ? AND (${chunkClauses})
          LIMIT 50
        `).all(projectId, ...chunkParams) as Array<{ id: string; summary: string; llm_channel: string }>;

        let compared = 0;
        let batchMatches = 0;
        let batchLatency = 0;
        const now = Date.now();

        for (const frag of recentFrags) {
          try {
            const slm = await classifyChannel(frag.summary);
            recordComparison(frag.summary, slm, { channel: frag.llm_channel });
            const match = slm.channel === frag.llm_channel ? 1 : 0;
            if (match) batchMatches++;
            batchLatency += slm.latencyMs;

            // Persist to DB for cross-batch accumulation
            db.prepare(`
              INSERT OR REPLACE INTO shadow_comparisons
              (id, project_id, fragment_id, summary_preview, slm_channel, llm_channel, slm_model, match_result, latency_ms, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              `sc-${now}-${compared}`,
              projectId,
              frag.id,
              frag.summary.slice(0, 200),
              slm.channel,
              frag.llm_channel,
              slmModel,
              match,
              slm.latencyMs,
              now,
            );
            compared++;
          } catch {}
        }

        if (compared > 0) {
          const batchMatchRate = compared > 0 ? (batchMatches / compared * 100) : 0;
          const batchAvgLatency = compared > 0 ? (batchLatency / compared) : 0;

          // Cumulative stats from DB (all batches)
          const cumStats = db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN match_result = 1 THEN 1 ELSE 0 END) as matches,
                   AVG(latency_ms) as avgLatency
            FROM shadow_comparisons WHERE project_id = ?
          `).get(projectId) as { total: number; matches: number; avgLatency: number };

          const cumMatchRate = cumStats.total > 0 ? (cumStats.matches / cumStats.total * 100) : 0;
          console.error(`[AgentMemory] SLM影子对比: 本批 ${compared} 条 匹配率 ${batchMatchRate.toFixed(0)}% 延时 ${batchAvgLatency.toFixed(0)}ms | 累计 ${cumStats.total} 条 匹配率 ${cumMatchRate.toFixed(0)}%`);
        }
      }
    } catch (e) {
      console.error(`[AgentMemory] SLM影子对比失败:`, (e as Error).message?.slice(0, 80));
    }
  }

  // Encoder shadow mode: two-stage macbert classifier vs LLM
  if (totalFragments > 0) {
    try {
      const { ensureReady, classify } = await import("../../smallmodel/encoder.js");
      const encoderReady = await ensureReady();

      if (encoderReady) {
        const chunkClauses = sessionIds.map(() => "(f.session_id = ? OR f.session_id LIKE ? || '__chunk%')").join(" OR ");
        const chunkParams: string[] = [];
        for (const sid of sessionIds) { chunkParams.push(sid, sid); }

        const recentFrags = db.prepare(`
          SELECT f.id, f.summary,
            (SELECT fa2.channel FROM fragment_anchors fa2 WHERE fa2.fragment_id = f.id ORDER BY fa2.weight DESC LIMIT 1) as llm_channel
          FROM fragments f
          WHERE f.project_id = ? AND (${chunkClauses})
          LIMIT 50
        `).all(projectId, ...chunkParams) as Array<{ id: string; summary: string; llm_channel: string }>;

        let encCompared = 0;
        let encMatches = 0;
        let encLatency = 0;
        const encNow = Date.now();

        for (const frag of recentFrags) {
          try {
            const t0 = Date.now();
            const result = await classify(frag.summary);
            const lat = Date.now() - t0;
            encLatency += lat;
            const match = result.label === frag.llm_channel ? 1 : 0;
            if (match) encMatches++;
            encCompared++;

            db.prepare(`
              INSERT OR REPLACE INTO shadow_comparisons
              (id, project_id, fragment_id, summary_preview, slm_channel, llm_channel, slm_model, match_result, latency_ms, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              `enc-${encNow}-${encCompared}`,
              projectId, frag.id, frag.summary.slice(0, 200),
              result.label, frag.llm_channel,
              "macbert-2stage", match, lat, encNow,
            );
          } catch {}
        }

        if (encCompared > 0) {
          const encMatchRate = (encMatches / encCompared * 100);
          const encAvgLatency = (encLatency / encCompared);

          const cumStats = db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN match_result = 1 THEN 1 ELSE 0 END) as matches,
                   AVG(latency_ms) as avgLatency
            FROM shadow_comparisons WHERE project_id = ? AND slm_model = 'macbert-2stage'
          `).get(projectId) as { total: number; matches: number; avgLatency: number };

          const cumRate = cumStats.total > 0 ? (cumStats.matches / cumStats.total * 100) : 0;
          console.error(`[AgentMemory] Encoder影子对比: 本批 ${encCompared} 条 匹配率 ${encMatchRate.toFixed(0)}% 延时 ${encAvgLatency.toFixed(0)}ms | 累计 ${cumStats.total} 条 匹配率 ${cumRate.toFixed(0)}%`);
        }
      }
    } catch (e) {
      console.error(`[AgentMemory] Encoder影子对比失败:`, (e as Error).message?.slice(0, 80));
    }
  }

  // Chain dreaming if threshold met
  const newFragments = db.prepare(
    "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND created_at > ? AND status = 'active'"
  ).get(projectId, lastDreamingAt) as { cnt: number };

  if (newFragments.cnt >= DREAMING_THRESHOLD) {
    const workerPath = path.join(__dirname, "dreaming-worker.js");
    spawn("node", [workerPath, `--project=${projectId}`, `--threshold=${DREAMING_THRESHOLD}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ...settingsEnv },
    }).unref();
    console.error(`[AgentMemory] 后台 Dreaming 已启动: ${newFragments.cnt} 条新碎片 (阈值 ${DREAMING_THRESHOLD})`);
  }
}

main().catch(() => process.exit(1));
