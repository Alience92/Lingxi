import type { MemoryEngine } from "../core/engine.js";
import { explicitSearch } from "../core/retriever.js";
import { fourLayerRecall } from "../core/backup-recall.js";
import { getDb } from "../db/connection.js";
import { buildFragmentationPrompt, parseFragmentationResponse, resolveLinks } from "../core/fragmenter.js";
import { scanExistingMemoryFiles, buildInstallMessage, injectAgentsMdAppendix } from "./install.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuid } from "uuid";

function promptModeResult(params: { transcript: string; sessionId: string; projectId: string }) {
  const prompt = buildFragmentationPrompt(params.transcript);
  return {
    mode: "prompt",
    prompt,
    transcript: params.transcript,
    sessionId: params.sessionId,
    projectId: params.projectId,
    instructions: "用你的LLM处理以上prompt和transcript，得到JSON数组后调用memory_store(fragments, sessionId, projectId)保存。fragments是channel/label/weight/linkedTo/summary的JSON数组。",
  };
}

function hasApiKey(engine: MemoryEngine): boolean {
  return !!(engine as any).config?.apiKey && (engine as any).config?.apiKey.length > 10;
}

export function buildToolHandlers(engine: MemoryEngine) {
  return {
    async memory_recall(params: { query?: string; projectId: string; workspaceDir: string }) {
      if (params.query) {
        return await explicitSearch(params.query, params.projectId);
      }
      const db = getDb();
      const fragments = db.prepare(`
        SELECT * FROM fragments WHERE project_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 10
      `).all(params.projectId) as Array<{ id: string; decay_score: number; recalled_count: number; last_recalled_at: number | null }>;

      // Bump recall counters so dreaming doesn't treat these as stale
      const now = Date.now();
      const bump = db.prepare(`
        UPDATE fragments SET last_recalled_at = ?, recalled_count = recalled_count + 1, decay_score = 1.0 WHERE id = ?
      `);
      for (const f of fragments) {
        bump.run(now, f.id);
      }

      return fragments;
    },

    async memory_remember(params: { transcript: string; sessionId: string; projectId: string }) {
      // If no fragmentation-capable API key, return prompt for Agent's LLM
      if (!engine.canFragment()) {
        return promptModeResult(params);
      }
      // Server-side fragmentation
      try {
        const fragments = await engine.fragmentSession({
          transcript: params.transcript,
          sessionId: params.sessionId,
          projectId: params.projectId,
        });
        if (fragments.length === 0) return promptModeResult(params);
        return { mode: "server", count: fragments.length, fragments: fragments.map((f) => ({ id: f.id, summary: f.summary })) };
      } catch {
        return promptModeResult(params);
      }
    },

    async memory_store(params: { fragments: Array<{ channel: string; label: string; weight?: number; linkedTo?: number[]; summary: string }>; sessionId: string; projectId: string }) {
      const { parseFragmentationResponse, resolveLinks } = await import("../core/fragmenter.js");
      const { persistFragments } = await import("../db/repository.js");

      const rawJson = JSON.stringify(params.fragments);
      const output = parseFragmentationResponse(rawJson, params.sessionId, params.projectId);
      if (output.fragments.length === 0) return { stored: 0, error: "No valid fragments parsed" };

      const rawFragments = params.fragments.map((f: any) => ({
        channel: f.channel,
        label: f.label,
        weight: f.weight ?? 10,
        linkedTo: f.linkedTo ?? [],
        summary: f.summary,
      }));
      resolveLinks(output.fragments, rawFragments);

      const persisted = await persistFragments({ output, sessionId: params.sessionId, projectId: params.projectId });
      return { stored: persisted.length, fragments: persisted.map((f) => ({ id: f.id, summary: f.summary })) };
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
      const db = getDb();

      // Ensure FK enforcement is on for this connection
      db.pragma("foreign_keys = ON");

      // Step 1: Decay
      const stats = engine.runDecay();

      // Step 2: Distillation — cluster similar labels, merge ≥3 into L0 rules
      const distilled = engine.runDistillation(params.projectId);

      const parts: string[] = [];
      if (stats.archived + stats.deleted > 0) parts.push(`已清理 ${stats.archived + stats.deleted} 条过期记忆`);
      if (distilled > 0) parts.push(`已蒸馏 ${distilled} 条规则（L0）`);
      if (parts.length === 0) parts.push("记忆库状态良好，无需清理");

      return {
        archived: stats.archived,
        deleted: stats.deleted,
        distilled,
        message: parts.join("，") + "。",
      };
    },

    async memory_bootstrap(params: { workspaceDir: string; projectId: string; confirm?: string }) {
      const workspaceDir = params.workspaceDir;

      // Step 1: Scan
      const estimate = scanExistingMemoryFiles(workspaceDir);
      const message = buildInstallMessage(estimate);

      // Step 2: If user confirmed, run batch import
      if (params.confirm === "Y" && estimate.fileCount > 0) {
        // If no API key, return all files as prompt-mode jobs for Agent's own LLM
        if (!hasApiKey(engine)) {
          const jobs = estimate.files.map((filePath) => {
            try {
              const content = fs.readFileSync(filePath, "utf-8");
              if (content.trim().length === 0) return null;
              return {
                file: path.basename(filePath),
                prompt: buildFragmentationPrompt(content),
                sessionId: `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                projectId: params.projectId,
              };
            } catch {
              return { file: path.basename(filePath), error: "Cannot read" };
            }
          }).filter(Boolean);

          return {
            mode: "prompt",
            estimate,
            jobs,
            instructions: `对每个job运行prompt，得到JSON数组后调用memory_store(fragments, sessionId, projectId)保存。共${jobs.length}个文件。建议批量处理，每个文件单独调用memory_store。`,
          };
        }

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
