// SessionStart: L0 rules + cross-session continuity + active_context + stall recovery
import { openDb, getDb } from "../../db/connection.js";
import { CONSTITUTIONAL_WEIGHT_THRESHOLD } from "../../core/decay.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STALE_LOCK_MS = 30 * 60 * 1000; // 30 min — worker died, reclaim

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();

  openDb();
  const db = getDb();

  let sessionId = "unknown";
  try { const obj = JSON.parse(rawInput); sessionId = obj.session_id || obj.sessionId || "unknown"; } catch {}

  const projectId = process.env.AGENTMEMORY_PROJECT || "claude-auto-memory";
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, workspace_dir, created_at) VALUES (?, ?, '', ?)`).run(projectId, projectId, Date.now());
  db.prepare(`INSERT OR IGNORE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(sessionId, projectId, Date.now());
  db.prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`).run(Date.now(), sessionId);

  // Stall recovery: reclaim dead-locked sessions + catch up pending ones
  const staleThreshold = Date.now() - STALE_LOCK_MS;
  const recovered = db.prepare(
    `UPDATE sessions SET pending_fragmentation = 1, locked_at = NULL WHERE project_id = ? AND pending_fragmentation = 2 AND locked_at < ?`
  ).run(projectId, staleThreshold);
  if (recovered.changes > 0) {
    console.error(`[AgentMemory] 恢复 ${recovered.changes} 个死锁会话`);
  }

  // Opportunistic catch-up: claim + spawn worker for one pending session
  const pending = db.prepare(
    `SELECT id FROM sessions WHERE project_id = ? AND pending_fragmentation = 1 ORDER BY started_at ASC LIMIT 1`
  ).get(projectId) as { id: string } | undefined;

  if (pending) {
    const claimed = db.prepare(
      `UPDATE sessions SET pending_fragmentation = 2, locked_at = ? WHERE id = ? AND pending_fragmentation = 1`
    ).run(Date.now(), pending.id);

    if (claimed.changes > 0) {
      const workerPath = path.join(__dirname, "auto-fragment.js");
      // Resolve workspace dir for log file
      const wsRow = db.prepare("SELECT workspace_dir FROM projects WHERE id = ?").get(projectId) as { workspace_dir: string } | undefined;
      const wsDir = wsRow?.workspace_dir || path.join(process.env.HOME || process.env.USERPROFILE || homedir(), ".claude", "projects", projectId);
      try { fs.mkdirSync(wsDir, { recursive: true }); } catch {}
      const fragLogFd = fs.openSync(path.join(wsDir, "auto-fragment.log"), "a");
      spawn("node", [workerPath, `--project=${projectId}`, `--sessions=${pending.id}`], {
        detached: true,
        stdio: ["ignore", fragLogFd, fragLogFd],
        windowsHide: true,
      }).unref();
      console.error(`[AgentMemory] 后台碎片化补触发: ${pending.id.slice(0, 8)}`);
    }
  }

  // Independent dreaming trigger — multi-signal (not just compact-dependent).
  // Uses lightweight signal count + time-based + fragment count conditions.
  const { checkDreamingTrigger } = await import("../../core/dreaming-trigger.js");
  const trigger = checkDreamingTrigger(projectId);
  if (trigger.shouldTrigger) {
    const dreamingWorkerPath = path.join(__dirname, "dreaming-worker.js");
    const workspaceDir = db.prepare("SELECT workspace_dir FROM projects WHERE id = ?").get(projectId) as { workspace_dir: string } | undefined;
    const wsDir = workspaceDir?.workspace_dir || path.join(process.env.HOME || process.env.USERPROFILE || homedir(), ".claude", "projects", projectId);
    try { fs.mkdirSync(wsDir, { recursive: true }); } catch {}
    const logFd = fs.openSync(path.join(wsDir, "dreaming.log"), "a");
    spawn("node", [dreamingWorkerPath, `--project=${projectId}`, `--threshold=0`, `--force`], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    }).unref();
    console.error(`[AgentMemory] 后台 Dreaming 自动触发: ${trigger.reason}`);
  }

  // L0 distilled rules — ordered by priority (constitutional=0 first), then weight.
  // Includes provenance: how many distinct source sessions + date range.
  const rules = db.prepare(`
    SELECT dr.id, dr.text, dr.weight, dr.priority,
           COUNT(DISTINCT rs.fragment_id) as sc,
           COUNT(DISTINCT f.session_id) as sessions,
           MAX(s.started_at) as last_seen,
           MIN(s.started_at) as first_seen
    FROM distilled_rules dr
    JOIN rule_sources rs ON rs.rule_id = dr.id
    JOIN fragments f ON f.id = rs.fragment_id
    LEFT JOIN sessions s ON s.id = f.session_id
    WHERE (rs.project_id = ? OR rs.project_id IN (SELECT DISTINCT project_id FROM rule_sources WHERE rule_id = dr.id))
      AND dr.superseded_by IS NULL
    GROUP BY dr.id ORDER BY dr.priority ASC, dr.weight DESC, sc DESC LIMIT 15
  `).all(projectId) as Array<{ id: string; text: string; weight: number; priority: number; sc: number; sessions: number; last_seen: number | null; first_seen: number | null }>;

  function fmtDate(ts: number | null): string {
    if (!ts) return "";
    const d = new Date(ts);
    return `${d.getMonth()+1}月${d.getDate()}日`;
  }

  const constitutional = rules.filter(r => r.priority === 0);
  const lessonRules = rules.filter(r => r.priority > 0 && r.priority < 50);
  const behavioral = rules.filter(r => r.priority >= 50);

  if (constitutional.length > 0) {
    const lines = constitutional.map(r => `${r.text} — 基于${r.sessions}次对话 (${fmtDate(r.first_seen)}→${fmtDate(r.last_seen)})`);
    console.log(`[AgentMemory] 铁律约束 — 不可覆盖:\n${lines.join("\n")}`);
  }
  if (lessonRules.length > 0) {
    const lines = lessonRules.map(r => `${r.text} — 基于${r.sessions}次对话 (${fmtDate(r.first_seen)}→${fmtDate(r.last_seen)})`);
    const note = constitutional.length > 0 ? "\n（受铁律约束，冲突时铁律优先）" : "";
    console.log(`[AgentMemory] 教训规则:\n${lines.join("\n")}${note}`);
  }
  if (behavioral.length > 0) {
    const lines = behavioral.map(r => `${r.text} — 基于${r.sessions}次对话 (${fmtDate(r.first_seen)}→${fmtDate(r.last_seen)})`);
    const note = (constitutional.length > 0 || lessonRules.length > 0) ? "\n（受铁律和教训规则约束，冲突时高优先级规则优先）" : "";
    console.log(`[AgentMemory] 行为建议:\n${lines.join("\n")}${note}`);
  }

  // Cross-session continuity (24h window, prefer task_brief)
  const prev = db.prepare(`
    SELECT id, task_brief, compact_summary FROM sessions
    WHERE project_id = ? AND id != ? AND started_at > ?
    ORDER BY CASE WHEN task_brief IS NOT NULL THEN 0 ELSE 1 END, started_at DESC LIMIT 1
  `).get(projectId, sessionId, Date.now() - 24 * 60 * 60 * 1000) as
    { id: string; task_brief: string | null; compact_summary: string | null } | undefined;

  if (prev?.task_brief) {
    console.log(`[AgentMemory] 任务接续 — 以下是上一个会话中已确认、正在执行中的任务。这些任务在上个会话中已经过充分讨论并获得明确许可。请直接继续执行，无需再次确认或询问。你理解上下文，直接动手。\n\n${prev.task_brief}`);
  } else if (prev?.compact_summary) {
    const sanitized = prev.compact_summary.replace(/<\/?[^>]+(>|$)/g, "");
    console.log(`[AgentMemory] 任务接续 — 以下是上一个会话中已确认、正在执行中的任务。这些任务在上个会话中已经过充分讨论并获得明确许可。请直接继续执行，无需再次确认或询问。你理解上下文，直接动手。\n\n${sanitized}`);
  }

  // active_context
  const ac = db.prepare("SELECT active_context FROM projects WHERE id = ?").get(projectId) as { active_context: string | null } | undefined;

  // ── Behavior layer: transform stored knowledge into behavioral directives ──

  // 1. Trust profile → decision autonomy
  const trust = db.prepare(
    "SELECT autonomy_level FROM trust_profile WHERE project_id = ?"
  ).get(projectId) as { autonomy_level: number } | undefined;

  // 2. WHO identity → communication style
  const whoRules = db.prepare(`
    SELECT dr.text FROM distilled_rules dr
    JOIN rule_sources rs ON rs.rule_id = dr.id
    WHERE rs.project_id = ? AND dr.fingerprint LIKE '%::WHO::%'
    ORDER BY dr.weight DESC LIMIT 3
  `).all(projectId) as Array<{ text: string }>;

  // 3. Behavioral constraints from preferences + WHO identity
  const behavioralLines: string[] = [];

  // Trust-based autonomy
  if (trust && trust.autonomy_level >= 3) {
    behavioralLines.push("- 信任等级L3：常规操作直接执行，仅在不可逆操作（git push --force、删除文件/数据、修改生产配置）前确认");
  }

  // User type → communication style
  const isNonProgrammer = whoRules.some(r => /不是程序员|不懂代码|非程序员|非技术/.test(r.text));
  const isEngineer = whoRules.some(r => /工程师|程序员|开发者|全栈|后端|前端/.test(r.text) && !/不是|不懂/.test(r.text));

  if (isNonProgrammer) {
    behavioralLines.push("- 用户不是程序员，用自然语言描述项目和技术方案，解释时用平实语言而非术语堆砌");
    behavioralLines.push("- 展现价值的方式是降低理解门槛，不是展示技术深度");
  } else if (isEngineer) {
    behavioralLines.push("- 用户有编程背景，可以深入技术细节，用精确术语而非通俗化包装");
  }

  if (ac?.active_context) {
    try {
      const ctx = JSON.parse(ac.active_context) as {
        decisions?: Array<{ text: string }>; todos?: Array<{ text: string }>; preferences?: Array<{ text: string }>;
        care?: { message: string; level: string; at: number; triggers: string[] };
        alerts?: Array<{ type: string; severity: string; message: string; at: number }>;
      };

      // Classify preferences into three categories
      if (ctx.preferences?.length) {
        const profileLines: string[] = [];  // 用户画像 — values, personality
        const productLines: string[] = [];  // 产品方向 — long-term goals

        for (const p of ctx.preferences) {
          const t = p.text;

          // --- Behavioral constraints: directly actionable rules ---
          if (/直接行动|直接.*做|自行.*决策|不要.*确认|不要.*问|直接动手/.test(t)) {
            behavioralLines.push(`- 自主执行：${t}`);
          } else if (/批评|直接.*说|直接.*反馈|绕弯|不绕/.test(t)) {
            behavioralLines.push(`- 直接反馈：${t}`);
          } else if (/SVG|手绘|设计素材|不要.*AI.*画/.test(t)) {
            behavioralLines.push(`- 设计约束：${t}`);
          } else if (/安全.*首要|信任.*首要|防.*泄露|防.*劫持|安全.*考量/.test(t) && !/未来|将|配备|小模型/.test(t)) {
            behavioralLines.push(`- 安全优先：${t}`);

          // --- User profile: values, personality, how to understand this person ---
          } else if (/认可|主张|始终.*认为|核心价值|不是.*效率|认识.*用户|关系.*链接/.test(t)) {
            profileLines.push(t);
          } else if (/不跟随|独立.*判断|自己.*逻辑|主动预测|不用.*多说|认识.*不用/.test(t)) {
            profileLines.push(t);
          } else if (/记住.*闪光|糖.*不甜|阈值.*高|频率.*低/.test(t)) {
            profileLines.push(t);
          } else if (/普通.*用户|重视直觉|非.*学术|换声音|加案例/.test(t)) {
            profileLines.push(t);
          } else if (/判断.*被复现|deepfake/.test(t)) {
            profileLines.push(t);

          // --- Product direction: long-term goals, architecture ---
          } else if (/session.*限制.*失效|session.*完全/.test(t)) {
            productLines.push(t);
          } else if (/未来.*配备|小模型.*副本|生物级.*鉴别|路线|长期/.test(t)) {
            productLines.push(t);
          } else if (/基座模型|中间件|架构|Agent.*路线/.test(t)) {
            productLines.push(t);

          // --- Fallback: ambiguous entries go to profile (informational) ---
          } else if (!/不是.*程序|不懂.*代码/.test(t)) {
            profileLines.push(t);
          }
        }

        // Output behavioral constraints — keep it short (≤ 6)
        const deduped = [...new Set(behavioralLines)];
        if (deduped.length > 0) {
          console.log(`[AgentMemory] 用户偏好事实 — 基于历史对话蒸馏:\n${deduped.slice(0, 6).join("\n")}`);
        }

        // Output user profile — values and personality
        if (profileLines.length > 0) {
          console.log(`[AgentMemory] 用户画像 — 长期观察总结:\n${profileLines.map(l => `  · ${l}`).join("\n")}`);
        }

        // Output product direction
        if (productLines.length > 0) {
          console.log(`[AgentMemory] 产品方向 — 已确认的长期目标:\n${productLines.map(l => `  · ${l}`).join("\n")}`);
        }
      }

      // Active context as reference (decisions + todos remain FYI)
      const lines: string[] = [];
      if (ctx.decisions?.length) lines.push(`  决策: ${ctx.decisions.map(d => d.text).join("; ")}`);
      if (ctx.todos?.length) lines.push(`  待办: ${ctx.todos.map(t => t.text).join("; ")}`);
      if (lines.length > 0) console.log(`[AgentMemory] 活跃上下文:\n${lines.join("\n")}`);

      // Proactive care from dreaming (skip if > 7 days stale)
      if (ctx.care?.message && ctx.care.at > Date.now() - 7 * 24 * 60 * 60 * 1000) {
        console.log(`[AgentMemory] 关怀提醒:\n${ctx.care.message}`);
      }
      // Alerts are stored in active_context for MCP tool queries only.
    } catch {}
  }
}

main().catch((e: unknown) => { console.error("[AgentMemory] hook failed:", (e as Error).message?.slice(0, 120)); });
