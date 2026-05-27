// Memory health monitor: aggregated stats for observability
import { getDb } from "../db/connection.js";

export interface MemoryHealth {
  fragmentTotal: number;
  fragmentActive: number;
  fragmentArchived: number;
  pendingFragmentationSessions: number;
  lastDreamingAt: string | null;
  lastFragmentationAt: string | null;

  // Query stats (last 24h)
  last24h: {
    totalQueries: number;
    zeroHitQueries: number;
    zeroHitRate: number;
    avgResultsPerQuery: number;
  };

  // Channel balance
  fragmentBalance: {
    WHAT: number;
    FEEL: number;
    WHO: number;
    WHERE: number;
  };

  // Top-level health flags
  alerts: string[];

  // SLM shadow comparison stats (cumulative, across all batches)
  shadowComparisons?: {
    total: number;
    matchRate: number;
    avgLatencyMs: number;
    byModel: Array<{
      model: string;
      total: number;
      matchRate: number;
      avgLatencyMs: number;
    }>;
    perChannel: Record<string, { correct: number; total: number }>;
  };
}

function toLocalISO(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const tzOff = -d.getTimezoneOffset();
  const tzSign = tzOff >= 0 ? "+" : "-";
  const tzH = pad(Math.floor(Math.abs(tzOff) / 60));
  const tzM = pad(Math.abs(tzOff) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}${tzSign}${tzH}:${tzM}`;
}

export function getMemoryHealth(projectId: string): MemoryHealth {
  const db = getDb();

  // Fragment counts
  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived
    FROM fragments WHERE project_id = ?
  `).get(projectId) as { total: number; active: number; archived: number };

  // Pending fragmentation sessions
  const pending = db.prepare(
    "SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ? AND pending_fragmentation > 0"
  ).get(projectId) as { cnt: number };

  // Last dreaming / fragmentation timestamps
  const lastDreaming = db.prepare(
    "SELECT last_dreaming_at FROM projects WHERE id = ?"
  ).get(projectId) as { last_dreaming_at: number | null } | undefined;
  const lastFrag = db.prepare(
    "SELECT MAX(created_at) as ts FROM fragments WHERE project_id = ?"
  ).get(projectId) as { ts: number | null };

  // Channel balance
  const channelDist = db.prepare(`
    SELECT fa.channel, COUNT(*) as cnt
    FROM fragment_anchors fa
    JOIN fragments f ON f.id = fa.fragment_id
    WHERE f.project_id = ? AND f.status = 'active'
    GROUP BY fa.channel
  `).all(projectId) as Array<{ channel: string; cnt: number }>;

  let whatCnt = 0, feelCnt = 0, whoCnt = 0, whereCnt = 0;
  for (const row of channelDist) {
    switch (row.channel) {
      case "WHAT": whatCnt = row.cnt; break;
      case "FEEL": feelCnt = row.cnt; break;
      case "WHO": whoCnt = row.cnt; break;
      case "WHERE": whereCnt = row.cnt; break;
    }
  }
  const totalAnchors = whatCnt + feelCnt + whoCnt + whereCnt;

  // Last 24h query stats
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const queryStats = db.prepare(`
    SELECT COUNT(*) as totalQueries,
           AVG(result_count) as avgResults
    FROM query_events
    WHERE project_id = ? AND searched_at > ?
  `).get(projectId, since) as { totalQueries: number; avgResults: number | null };

  // Zero-hit queries: count queries with 0-1 results from query_events
  const zeroHit = db.prepare(`
    SELECT COUNT(*) as cnt FROM query_events
    WHERE project_id = ? AND searched_at > ? AND result_count <= 1
  `).get(projectId, since) as { cnt: number };

  // Alerts
  const alerts: string[] = [];
  if (pending.cnt > 10) alerts.push(`碎片化积压: ${pending.cnt} 个会话待处理`);
  if (queryStats.totalQueries > 0 && zeroHit.cnt / queryStats.totalQueries > 0.20) {
    alerts.push(`零命中率过高: ${((zeroHit.cnt / queryStats.totalQueries) * 100).toFixed(0)}% (> 20%阈值)`);
  }
  if (whatCnt / Math.max(1, totalAnchors) > 0.80) {
    alerts.push(`WHAT通道占比过高: ${((whatCnt / totalAnchors) * 100).toFixed(0)}% — 检查WHERE/WHO提取`);
  }
  const lastDreamingTs = lastDreaming?.last_dreaming_at;
  if (!lastDreamingTs || (Date.now() - lastDreamingTs) > 48 * 60 * 60 * 1000) {
    alerts.push("Dreaming超过48小时未运行 — 记忆可能未衰减/蒸馏");
  }

  // SLM shadow comparison cumulative stats
  let shadowComparisons: MemoryHealth["shadowComparisons"] = undefined;
  const hasShadowTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shadow_comparisons'").get();
  if (hasShadowTable) {
    const shadowStats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN match_result = 1 THEN 1 ELSE 0 END) as matches,
             AVG(latency_ms) as avgLatency
      FROM shadow_comparisons WHERE project_id = ?
    `).get(projectId) as { total: number; matches: number; avgLatency: number } | undefined;

    if (shadowStats && shadowStats.total > 0) {
      const perChannel = db.prepare(`
        SELECT llm_channel as channel,
               COUNT(*) as total,
               SUM(CASE WHEN match_result = 1 THEN 1 ELSE 0 END) as correct
        FROM shadow_comparisons WHERE project_id = ?
        GROUP BY llm_channel
      `).all(projectId) as Array<{ channel: string; total: number; correct: number }>;

      const channelMap: Record<string, { correct: number; total: number }> = {};
      for (const row of perChannel) {
        channelMap[row.channel] = { correct: row.correct, total: row.total };
      }

      const byModel = db.prepare(`
        SELECT slm_model as model,
               COUNT(*) as total,
               SUM(CASE WHEN match_result = 1 THEN 1 ELSE 0 END) as matches,
               AVG(latency_ms) as avgLatency
        FROM shadow_comparisons WHERE project_id = ?
        GROUP BY slm_model ORDER BY total DESC
      `).all(projectId) as Array<{ model: string; total: number; matches: number; avgLatency: number }>;

      shadowComparisons = {
        total: shadowStats.total,
        matchRate: shadowStats.total > 0 ? shadowStats.matches / shadowStats.total : 0,
        avgLatencyMs: shadowStats.avgLatency ?? 0,
        byModel: byModel.map(m => ({
          model: m.model,
          total: m.total,
          matchRate: m.total > 0 ? m.matches / m.total : 0,
          avgLatencyMs: m.avgLatency ?? 0,
        })),
        perChannel: channelMap,
      };
    }
  }

  const result: MemoryHealth = {
    fragmentTotal: counts.total,
    fragmentActive: counts.active,
    fragmentArchived: counts.archived,
    pendingFragmentationSessions: pending.cnt,
    lastDreamingAt: lastDreamingTs ? toLocalISO(lastDreamingTs) : null,
    lastFragmentationAt: lastFrag.ts ? toLocalISO(lastFrag.ts) : null,

    last24h: {
      totalQueries: queryStats.totalQueries,
      zeroHitQueries: zeroHit.cnt,
      zeroHitRate: queryStats.totalQueries > 0 ? zeroHit.cnt / queryStats.totalQueries : 0,
      avgResultsPerQuery: queryStats.avgResults ?? 0,
    },

    fragmentBalance: {
      WHAT: totalAnchors > 0 ? whatCnt / totalAnchors : 0,
      FEEL: totalAnchors > 0 ? feelCnt / totalAnchors : 0,
      WHO: totalAnchors > 0 ? whoCnt / totalAnchors : 0,
      WHERE: totalAnchors > 0 ? whereCnt / totalAnchors : 0,
    },

    alerts,
  };
  if (shadowComparisons) result.shadowComparisons = shadowComparisons;
  return result;
}
