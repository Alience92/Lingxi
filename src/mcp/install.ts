import * as fs from "node:fs";
import * as path from "node:path";
import type { InstallEstimate } from "../types.js";

const MEMORY_FILE_PATTERNS = [
  "MEMORY.md",
  "memory/*.md",
  "HEARTBEAT.md",
  "CLAUDE.md",
  "AGENTS.md",
];

export function scanExistingMemoryFiles(workspaceDir: string): InstallEstimate {
  const files: string[] = [];
  let totalBytes = 0;

  for (const pattern of MEMORY_FILE_PATTERNS) {
    if (pattern.includes("*")) {
      const dirPath = path.join(workspaceDir, path.dirname(pattern));
      const ext = path.extname(pattern);
      if (fs.existsSync(dirPath)) {
        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
          if (entry.endsWith(ext)) {
            const fullPath = path.join(dirPath, entry);
            try {
              const stat = fs.statSync(fullPath);
              files.push(fullPath);
              totalBytes += stat.size;
            } catch { /* skip unreadable */ }
          }
        }
      }
    } else {
      const fullPath = path.join(workspaceDir, pattern);
      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          files.push(fullPath);
          totalBytes += stat.size;
        } catch { /* skip unreadable */ }
      }
    }
  }

  // Fallback: also scan the workspaceDir itself for .md files directly.
  // This handles the case where the user passes the memory directory itself
  // rather than the project root (patterns like "memory/*.md" would resolve
  // to a non-existent subdirectory inside an already-named memory folder).
  for (const entry of fs.readdirSync(workspaceDir)) {
    if (entry.endsWith(".md") && entry.toUpperCase() !== "MEMORY.MD") {
      const fullPath = path.join(workspaceDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && !files.includes(fullPath)) {
          files.push(fullPath);
          totalBytes += stat.size;
        }
      } catch { /* skip unreadable */ }
    }
  }

  // Also scan transcripts
  const transcriptDir = path.join(workspaceDir, "transcripts");
  if (fs.existsSync(transcriptDir)) {
    const entries = fs.readdirSync(transcriptDir);
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) {
        const fullPath = path.join(transcriptDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          files.push(fullPath);
          totalBytes += stat.size;
        } catch { /* skip unreadable */ }
      }
    }
  }

  const estimatedTokens = Math.ceil(totalBytes * 0.4);
  const estimatedTimeMinutes = Math.max(1, Math.ceil(estimatedTokens / 50000));

  return {
    fileCount: files.length,
    totalBytes,
    estimatedTokens,
    estimatedTimeMinutes,
    files: files.slice(0, 50),
  };
}

export function buildInstallMessage(estimate: InstallEstimate): string {
  if (estimate.fileCount === 0) {
    return "未发现现有记忆文件。AgentMemory 已就绪，将在本次对话结束后开始建立记忆索引。";
  }
  const sizeMB = (estimate.totalBytes / 1024 / 1024).toFixed(1);
  return [
    `发现 ${estimate.fileCount} 个记忆文件，共 ${sizeMB} MB。`,
    `导入预计消耗 ~${estimate.estimatedTokens.toLocaleString()} tokens，耗时约 ${estimate.estimatedTimeMinutes} 分钟。`,
    `是否导入？导入后 Agent 可以立即回忆起之前的对话内容。`,
    `回复 "Y" 开始导入，回复 "n" 跳过（可稍后手动导入）。`,
  ].join("\n");
}

export function injectAgentsMdAppendix(workspaceDir: string, appendix: string): void {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  for (const name of candidates) {
    const fullPath = path.join(workspaceDir, name);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (!content.includes("AgentMemory")) {
        fs.writeFileSync(fullPath, content + "\n" + appendix + "\n");
      }
      return;
    }
  }
  // Neither exists, create AGENTS.md
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), appendix + "\n");
}
