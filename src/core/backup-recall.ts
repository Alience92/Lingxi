import type { SearchResult, Fragment } from "../types.js";
import { getDb } from "../db/connection.js";
import { explicitSearch } from "./retriever.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RecallResult {
  fragments: SearchResult[];
  source: "L1" | "L1_archive" | "L3_transcript" | "L4_project_files" | "not_found";
  message?: string;
}

export async function fourLayerRecall(
  queryText: string,
  projectId: string,
  workspaceDir: string
): Promise<RecallResult> {
  // Layer 1: Active L1 fragments
  const l1Results = await explicitSearch(queryText, projectId, 0.35, 5);
  if (l1Results.length > 0) {
    return { fragments: l1Results, source: "L1" };
  }

  // Layer 2: L1_archive (archived fragments, FTS5 search)
  const db = getDb();
  const ftsQuery = queryText.replace(/\s+/g, " AND ");
  let archiveRows: Fragment[] = [];
  try {
    archiveRows = db.prepare(`
      SELECT f.* FROM fragments f
      WHERE f.project_id = ? AND f.status = 'archived'
      AND f.id IN (SELECT rowid FROM fragments_fts WHERE fragments_fts MATCH ?)
      LIMIT 5
    `).all(projectId, ftsQuery) as Fragment[];
  } catch {
    archiveRows = [];
  }

  if (archiveRows.length > 0) {
    for (const row of archiveRows) {
      db.prepare(`UPDATE fragments SET status = 'active', decay_score = 0.5 WHERE id = ?`).run(row.id);
    }
    const reactivatedResults = await explicitSearch(queryText, projectId, 0.3, 5);
    return {
      fragments: reactivatedResults,
      source: "L1_archive",
      message: "这个比较久了，翻了一下记录...",
    };
  }

  // Layer 3: Raw transcript files
  const transcriptDir = path.join(workspaceDir, "transcripts");
  if (fs.existsSync(transcriptDir)) {
    const files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl")).slice(-30);
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(transcriptDir, file), "utf-8");
        if (content.toLowerCase().includes(queryText.toLowerCase())) {
          return {
            fragments: [],
            source: "L3_transcript",
            message: `记得不是很清楚，但在转录文件 ${file} 里有提到相关内容...`,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Layer 4: Project design files (date-correlated)
  const designDirs = ["设计文档", "design-docs", "docs", "specs"];
  for (const dir of designDirs) {
    const fullPath = path.join(workspaceDir, dir);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const designFiles = fs.readdirSync(fullPath).filter((f) => f.endsWith(".md"));
      for (const file of designFiles) {
        try {
          const content = fs.readFileSync(path.join(fullPath, file), "utf-8");
          if (content.toLowerCase().includes(queryText.toLowerCase())) {
            return {
              fragments: [],
              source: "L4_project_files",
              message: `我查了项目文档 ${dir}/${file}，找到了相关内容...`,
            };
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  // Not found
  return {
    fragments: [],
    source: "not_found",
    message: "我不记得这件事，可能没有记录。",
  };
}
