import type { MemoryEngine } from "../core/engine.js";
import { explicitSearch } from "../core/retriever.js";
import { fourLayerRecall } from "../core/backup-recall.js";
import { getDb } from "../db/connection.js";

export function buildToolHandlers(engine: MemoryEngine) {
  return {
    async memory_recall(params: { query?: string; projectId: string; workspaceDir: string }) {
      if (params.query) {
        return await explicitSearch(params.query, params.projectId);
      }
      const db = getDb();
      return db.prepare(`
        SELECT * FROM fragments WHERE project_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 10
      `).all(params.projectId);
    },

    async memory_remember(params: { transcript: string; sessionId: string; projectId: string }) {
      const fragments = await engine.fragmentSession({
        transcript: params.transcript,
        sessionId: params.sessionId,
        projectId: params.projectId,
      });
      return { count: fragments.length, fragments: fragments.map((f) => ({ id: f.id, summary: f.summary })) };
    },

    async memory_search(params: { query: string; projectId: string; maxResults?: number; minScore?: number }) {
      return await explicitSearch(params.query, params.projectId, params.minScore, params.maxResults);
    },

    async memory_get(params: { fragmentId: string }) {
      const db = getDb();
      const fragment = db.prepare(`SELECT * FROM fragments WHERE id = ?`).get(params.fragmentId);
      const anchors = db.prepare(`SELECT * FROM fragment_anchors WHERE fragment_id = ?`).all(params.fragmentId);
      const links = db.prepare(`
        SELECT f.id, f.summary FROM fragment_links l
        JOIN fragments f ON f.id = l.target_id WHERE l.source_id = ?
      `).all(params.fragmentId);
      return { fragment, anchors, links };
    },

    async memory_recall_deep(params: { query: string; projectId: string; workspaceDir: string }) {
      return await fourLayerRecall(params.query, params.projectId, params.workspaceDir);
    },

    async dreaming(params: { projectId: string }) {
      const stats = engine.runDecay();
      return {
        ...stats,
        message: stats.archived + stats.deleted > 0
          ? `已清理 ${stats.archived + stats.deleted} 条过期记忆。`
          : "记忆库状态良好，无需清理。",
      };
    },
  };
}
