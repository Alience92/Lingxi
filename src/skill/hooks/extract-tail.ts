// Extract the last N messages from a Claude Code transcript JSONL file.
// Reads only the tail of the file to avoid loading huge transcripts into memory.

import * as fs from "node:fs";

const TAIL_BYTES = 128 * 1024;
const MAX_MESSAGES = 20;
const TARGET_CHARS = 1500;
const MAX_PER_MSG = 400;

interface ExtractedMessage {
  role: string;
  text: string;
}

export function extractTranscriptTail(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size < 200) return null;

  let content: string;
  try {
    const fd = fs.openSync(filePath, "r");
    const readStart = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - readStart);
    fs.readSync(fd, buf, 0, buf.length, readStart);
    fs.closeSync(fd);
    content = buf.toString("utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter(Boolean);
  const messages: ExtractedMessage[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);

      if (obj.type === "user" || obj.type === "assistant") {
        let text = "";
        if (obj.message?.content) {
          if (Array.isArray(obj.message.content)) {
            const textBlocks: string[] = [];
            for (const block of obj.message.content) {
              if (block.type === "text" && block.text) {
                textBlocks.push(block.text);
              } else if (block.type === "tool_use") {
                textBlocks.push(`[调用工具: ${block.name || "unknown"}]`);
              }
            }
            text = textBlocks.join(" ");
          } else {
            text = String(obj.message.content);
          }
        }
        if (text.trim()) {
          const role = obj.type === "user" ? "用户" : "助手";
          messages.push({ role, text: text.slice(0, MAX_PER_MSG) });
        }
      } else if (obj.type === "tool_result") {
        const toolName = obj.tool_use_name || obj.name || "";
        let resultText = "";
        if (obj.message?.content) {
          if (Array.isArray(obj.message.content)) {
            resultText = obj.message.content
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { text: string }) => c.text)
              .join(" ");
          } else {
            resultText = String(obj.message.content);
          }
        }
        const shortResult = resultText.slice(0, 200);
        if (toolName || shortResult) {
          messages.push({
            role: "工具",
            text: toolName ? `[${toolName}]: ${shortResult}` : shortResult,
          });
        }
      }
    } catch {
      // skip individual malformed lines
    }
  }

  if (messages.length === 0) return null;

  const tail = messages.slice(-MAX_MESSAGES);
  const out: string[] = [];
  let total = 0;
  for (const m of tail) {
    const line = `${m.role}: ${m.text}`;
    if (total + line.length > TARGET_CHARS + 500) break;
    out.push(line);
    total += line.length;
  }

  if (out.length === 0) return null;
  return out.join("\n");
}
