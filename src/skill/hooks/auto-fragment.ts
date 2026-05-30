// Standalone background worker for auto-fragmentation.
// Spawned by SessionStart hook; runs detached so the user never waits on it.

import { openDb, getDb } from "../../db/connection.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { loadSettingsEnv } from "./settings.js";
import type { MemoryEngine } from "../engine.js";
import { fileURLToPath } from "node:url";

const PER_SESSION_TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_CHARS = 30_000;
const DREAMING_THRESHOLD = 100;
const MAX_CHUNKS_PER_RUN = 15;       // hard cap — never process more than this many chunks
const MAX_CHUNKS_INCREMENTAL = 5;    // for already-fragmented sessions, only process last N chunks

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  filePath: string,
  maxChunks: number = MAX_CHUNKS_PER_RUN,
): Promise<number> {
  const conversation = extractConversation(filePath);
  if (conversation.length === 0) return 0;

  const fullTranscript = conversation.join("\n");
  if (fullTranscript.length < 200) return 0;

  let chunks = chunkConversation(conversation, MAX_TRANSCRIPT_CHARS);
  const totalChunks = chunks.length;

  // Compute chunk offset: for incremental mode, start numbering from where
  // the last run left off. This prevents chunk ID collisions with prior runs.
  let chunkOffset = 0;
  if (chunks.length > maxChunks) {
    chunkOffset = totalChunks - maxChunks;
    chunks = chunks.slice(-maxChunks);
  }

  let totalFragments = 0;
  let anyChunkFailed = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunkIdx = chunkOffset + i;
    try {
      const result: unknown = await withTimeout(
        engine.fragmentSession({
          sessionId: totalChunks > 1 ? `${sessionId}__chunk${chunkIdx}` : sessionId,
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

  let engine: MemoryEngine | null = null;
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

      // If session was already fragmented, only process newest content
      const sess = db.prepare("SELECT fragmented_at FROM sessions WHERE id = ?").get(sessionId) as { fragmented_at: number | null } | undefined;
      const alreadyFragmented = !!(sess?.fragmented_at);
      const maxChunks = alreadyFragmented ? MAX_CHUNKS_INCREMENTAL : MAX_CHUNKS_PER_RUN;
      if (alreadyFragmented) {
        console.error(`[AgentMemory] 会话已碎片化，仅处理最近 ${MAX_CHUNKS_INCREMENTAL} 个chunk`);
      }

      const count = await fragmentOneSession(engine, sessionId, projectId, jsonlPath, maxChunks);
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

  // Encoder production mode: two-stage macbert classifier replaces LLM for channel classification.
  // Previously shadow-only (record comparison, don't override). Now encoder result actually
  // updates fragment_anchors when confidence ≥ 0.6. Fallback to LLM few-shot when < 0.6.
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
            (SELECT fa2.id FROM fragment_anchors fa2 WHERE fa2.fragment_id = f.id ORDER BY fa2.weight DESC LIMIT 1) as anchor_id,
            (SELECT fa2.channel FROM fragment_anchors fa2 WHERE fa2.fragment_id = f.id ORDER BY fa2.weight DESC LIMIT 1) as llm_channel
          FROM fragments f
          WHERE f.project_id = ? AND (${chunkClauses})
          LIMIT 50
        `).all(projectId, ...chunkParams) as Array<{ id: string; summary: string; anchor_id: number | null; llm_channel: string }>;

        let encCompared = 0;
        let encMatches = 0;
        let encOverrides = 0;
        let encLatency = 0;
        const encNow = Date.now();

        let classifyFallback: ((text: string) => Promise<{ label: "WHAT" | "FEEL" | "WHERE" | "WHO"; confidence: number; source: string }>) | null = null;
        let fallbackUsed = 0;

        for (const frag of recentFrags) {
          try {
            const t0 = Date.now();
            const encoderResult = await classify(frag.summary);
            const encoderLabel = encoderResult.label;
            const encoderConf = encoderResult.confidence;
            let finalLabel = encoderLabel;
            let modelName = "macbert-2stage";
            let fallbackUsedFlag = 0;

            if (encoderResult.confidence < 0.6 && fragmentationKey && fragmentationKey.length > 10) {
              if (!classifyFallback) {
                const fb = await import("../../smallmodel/fallback.js");
                classifyFallback = (text: string) =>
                  fb.classifyFallback(text, fragmentationKey, fragmentationBaseURL);
              }
              try {
                const fbResult = await classifyFallback(frag.summary);
                finalLabel = fbResult.label;
                modelName = "macbert-2stage+fallback";
                fallbackUsedFlag = 1;
                fallbackUsed++;
              } catch {}
            }

            const lat = Date.now() - t0;
            encLatency += lat;
            const match = finalLabel === frag.llm_channel ? 1 : 0;
            if (match) encMatches++;
            encCompared++;

            // Production override: encoder-assigned channel replaces LLM channel.
            // Also normalize weight (FEEL→non-FEEL drops to default) and update
            // label to reflect encoder source, preventing channel/label mismatch.
            const VALID_CH = ["WHAT", "FEEL", "WHERE", "WHO"];
            if (frag.anchor_id && finalLabel !== frag.llm_channel && VALID_CH.includes(finalLabel)) {
              const ch = finalLabel as typeof VALID_CH[number];
              const isFeelSwitch = frag.llm_channel === "FEEL" && ch !== "FEEL";
              if (isFeelSwitch) {
                // FEEL→non-FEEL: drop weight to default and note encoder override
                db.prepare(`UPDATE fragment_anchors SET channel = ?, weight = 10, source = 'clustering' WHERE id = ?`).run(ch, frag.anchor_id);
              } else {
                db.prepare(`UPDATE fragment_anchors SET channel = ? WHERE id = ?`).run(ch, frag.anchor_id);
              }
              encOverrides++;
            }

            db.prepare(`
              INSERT OR REPLACE INTO shadow_comparisons
              (id, project_id, fragment_id, summary_preview, slm_channel, llm_channel, slm_model, match_result, latency_ms, encoder_label, encoder_confidence, fallback_used, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              `enc-${encNow}-${encCompared}`,
              projectId, frag.id, frag.summary.slice(0, 200),
              finalLabel, frag.llm_channel,
              modelName, match, lat,
              encoderLabel, encoderConf, fallbackUsedFlag,
              encNow,
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
            FROM shadow_comparisons WHERE project_id = ? AND slm_model IN ('macbert-2stage', 'macbert-2stage+fallback')
          `).get(projectId) as { total: number; matches: number; avgLatency: number };

          const cumRate = cumStats.total > 0 ? (cumStats.matches / cumStats.total * 100) : 0;
          const fbNote = fallbackUsed > 0 ? ` (${fallbackUsed}条fallback)` : "";
          const ovNote = encOverrides > 0 ? ` 覆盖${encOverrides}条` : "";
          console.error(`[AgentMemory] 编码器通道分类: ${encCompared}条 匹配率${encMatchRate.toFixed(0)}% 延时${encAvgLatency.toFixed(0)}ms${fbNote} | 累计${cumStats.total}条 ${cumRate.toFixed(0)}%${ovNote}`);
        }
      }
    } catch (e) {
      console.error(`[AgentMemory] Encoder分类失败:`, (e as Error).message?.slice(0, 80));
    }
  }

  // Feed FEEL-channel fragments into relationship profile
  if (totalFragments > 0 && engine) {
    try {
      const feelFrags = db.prepare(`
        SELECT fa.label, fa.weight FROM fragment_anchors fa
        JOIN fragments f ON f.id = fa.fragment_id
        WHERE f.project_id = ? AND fa.channel = 'FEEL'
          AND f.created_at > ? AND fa.weight >= 30
        ORDER BY fa.weight DESC LIMIT 10
      `).all(projectId, Date.now() - 60 * 60 * 1000) as Array<{ label: string; weight: number }>;

      for (const ff of feelFrags) {
        try {
          engine.recordFeelEvent(projectId, ff.label, ff.weight);
        } catch {}
      }
      if (feelFrags.length > 0) {
        const profile = engine.getRelationshipProfile(projectId);
        console.error(`[AgentMemory] 关系档案: friction=${profile.frictionScore} autonomy=${profile.autonomyBudget} level=${profile.trustLevel}`);
      }
    } catch {}
  }

  // Chain dreaming if threshold met
  const newFragments = db.prepare(
    "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND created_at > ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'"
  ).get(projectId, lastDreamingAt) as { cnt: number };

  if (newFragments.cnt >= DREAMING_THRESHOLD) {
    const workerPath = path.join(__dirname, "dreaming-worker.js");
    const logFile = path.join(workspaceDir, "dreaming.log");
    const logFd = fs.openSync(logFile, "a");
    spawn("node", [workerPath, `--project=${projectId}`, `--threshold=${DREAMING_THRESHOLD}`], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: { ...process.env, ...settingsEnv },
    }).unref();
    console.error(`[AgentMemory] 后台 Dreaming 已启动: ${newFragments.cnt} 条新碎片 (阈值 ${DREAMING_THRESHOLD})`);
  }
}

main().catch((e: unknown) => { console.error("[AgentMemory] hook failed:", (e as Error).message?.slice(0, 120)); process.exit(1); });
