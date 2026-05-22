import type { SearchResult } from "../types.js";
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

  // Layer 2: L1_archive (archived fragments, FTS5 search via repository)
  const { searchArchiveFragments } = await import("../db/repository.js");
  const archiveRows = searchArchiveFragments(queryText, projectId, 5);

  if (archiveRows.length > 0) {
    const db = getDb();
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

  // Layer 3: Raw transcript files — substring match + trigger on-the-fly fragmentation hint
  const transcriptDir = path.join(workspaceDir, "transcripts");
  if (fs.existsSync(transcriptDir)) {
    const files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl")).slice(-30);
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(transcriptDir, file), "utf-8");
        const lowerContent = content.toLowerCase();
        const lowerQuery = queryText.toLowerCase();
        if (lowerContent.includes(lowerQuery)) {
          // Extract surrounding context (±300 chars around first match)
          const idx = lowerContent.indexOf(lowerQuery);
          const start = Math.max(0, idx - 300);
          const end = Math.min(content.length, idx + lowerQuery.length + 300);
          const snippet = content.slice(start, end);
          return {
            fragments: [],
            source: "L3_transcript",
            message: `记得不是很清楚，但在转录文件 ${file} 里有提到相关内容。建议对该转录执行 memory_remember 进行碎片化：\n...${snippet.slice(0, 200)}...`,
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Layer 4: Project design files (date-correlated by filename patterns)
  const designDirs = ["设计文档", "design-docs", "docs", "specs"];
  // Extract date patterns from query to narrow search
  const datePattern = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{4}\.(0?[1-9]|1[0-2])|202[0-6]/;
  const dateMatch = queryText.match(datePattern);
  for (const dir of designDirs) {
    const fullPath = path.join(workspaceDir, dir);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const designFiles = fs.readdirSync(fullPath)
        .filter((f) => f.endsWith(".md"))
        // If a date was found in the query, prefer files matching that date
        .sort((a, b) => {
          if (dateMatch) {
            const aMatch = a.includes(dateMatch[0]!) ? -1 : 1;
            const bMatch = b.includes(dateMatch[0]!) ? -1 : 1;
            return aMatch - bMatch;
          }
          return b.localeCompare(a); // Newest first
        });
      for (const file of designFiles.slice(0, 20)) {
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
