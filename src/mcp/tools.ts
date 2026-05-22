import type { MemoryEngine } from "../core/engine.js";
import { explicitSearch } from "../core/retriever.js";
import { fourLayerRecall } from "../core/backup-recall.js";
import { getDb } from "../db/connection.js";
import { scanExistingMemoryFiles, buildInstallMessage, injectAgentsMdAppendix } from "./install.js";
import * as fs from "node:fs";
import * as path from "node:path";

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

    async memory_bootstrap(params: { workspaceDir: string; projectId: string; confirm?: string }) {
      const workspaceDir = params.workspaceDir;

      // Step 1: Scan
      const estimate = scanExistingMemoryFiles(workspaceDir);
      const message = buildInstallMessage(estimate);

      // Step 2: If user confirmed, run batch import
      if (params.confirm === "Y" && estimate.fileCount > 0) {
        const results: Array<{ file: string; fragments: number; error?: string }> = [];

        for (const filePath of estimate.files) {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            if (content.trim().length === 0) continue;
            const fragments = await engine.fragmentSession({
              transcript: content,
              sessionId: `bootstrap-${Date.now()}`,
              projectId: params.projectId,
            });
            results.push({ file: path.basename(filePath), fragments: fragments.length });
          } catch (err) {
            results.push({ file: path.basename(filePath), fragments: 0, error: String(err) });
          }
        }

        // Inject AGENTS.md appendix
        const appendix = "## Memory\n\nThis project uses AgentMemory.\n- Session start: call memory_recall() without query to get recent context.\n- Important decisions: call memory_remember(transcript, sessionId, projectId).\n- Deep search: call memory_recall_deep(query, projectId, workspaceDir).\n- Manual cleanup: call dreaming(projectId).";
        injectAgentsMdAppendix(workspaceDir, appendix);

        const totalFragments = results.reduce((s, r) => s + r.fragments, 0);
        const errors = results.filter((r) => r.error);
        return {
          estimate,
          imported: true,
          totalFragments,
          fileResults: results,
          errors: errors.length > 0 ? errors : undefined,
          message: `已导入 ${totalFragments} 条碎片（${results.length} 个文件）${errors.length > 0 ? `，${errors.length} 个文件失败` : ""}。AgentMemory 已就绪。`,
        };
      }

      // Step 3: Just scanning, return estimate
      return { estimate, imported: false, message };
    },
  };
}
