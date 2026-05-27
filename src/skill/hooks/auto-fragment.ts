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
    const jsonlPath = path.join(workspaceDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) {
      db.prepare(`UPDATE sessions SET pending_fragmentation = 0, fragmented_at = ? WHERE id = ?`).run(Date.now(), sessionId);
      continue;
    }

    const count = await fragmentOneSession(engine, sessionId, projectId, jsonlPath);
    if (count > 0) {
      totalFragments += count;
      processed++;
    }

    db.prepare(`UPDATE sessions SET pending_fragmentation = 0, fragmented_at = ? WHERE id = ?`).run(Date.now(), sessionId);
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
    }).unref();
    console.error(`[AgentMemory] 后台 Dreaming 已启动: ${newFragments.cnt} 条新碎片 (阈值 ${DREAMING_THRESHOLD})`);
  }
}

main().catch(() => process.exit(1));
