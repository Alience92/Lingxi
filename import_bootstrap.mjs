// Full bootstrap import: scan + import all memory files
import { startServer } from "./dist/mcp/server.js";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;

// We don't need the full MCP server — let's just use the underlying components directly
import { MemoryEngine } from "./dist/core/engine.js";
import { scanExistingMemoryFiles, buildInstallMessage, injectAgentsMdAppendix } from "./dist/mcp/install.js";
import { getDb, openDb } from "./dist/db/connection.js";
import * as fs from "node:fs";
import * as path from "node:path";

const workspaceDir = process.argv[2] || "C:\\Users\\Administrator\\.claude\\projects\\C--Users-Administrator";
const projectId = process.argv[3] || "claude-auto-memory";
const confirm = process.argv[4] || "";

console.log(`Workspace: ${workspaceDir}`);
console.log(`Project ID: ${projectId}\n`);

// Initialize database
openDb();
console.log("Database opened.");

// Initialize engine
const apiKey = process.env.ANTHROPIC_API_KEY || "";
console.log(`API Key: ${apiKey ? apiKey.substring(0, 8) + "..." : "NOT SET"}`);

const engine = new MemoryEngine({
  apiKey,
  baseURL: "https://api.deepseek.com",
  model: "deepseek-chat",
});

// Step 1: Scan
const estimate = scanExistingMemoryFiles(workspaceDir);
const message = buildInstallMessage(estimate);
console.log(message);

if (estimate.fileCount === 0) {
  console.log("No files to import. Done.");
  process.exit(0);
}

if (confirm !== "Y") {
  console.log('\n--- Preview mode. Add "Y" as third arg to execute import ---');
  process.exit(0);
}

// Step 2: Import
console.log("\n--- Starting import... ---\n");

const results = [];
for (let i = 0; i < estimate.files.length; i++) {
  const filePath = estimate.files[i];
  const fileName = path.basename(filePath);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.trim().length === 0) {
      console.log(`[${i + 1}/${estimate.files.length}] SKIP (empty): ${fileName}`);
      continue;
    }
    console.log(`[${i + 1}/${estimate.files.length}] Fragmenting: ${fileName} (${content.length} chars)...`);
    const fragments = await engine.fragmentSession({
      transcript: content,
      sessionId: `bootstrap-${Date.now()}-${i}`,
      projectId,
    });
    results.push({ file: fileName, fragments: fragments.length });
    console.log(`  -> ${fragments.length} fragments`);
  } catch (err) {
    console.error(`  -> ERROR: ${err}`);
    results.push({ file: fileName, fragments: 0, error: String(err) });
  }
}

// Inject AGENTS.md appendix
const appendix = [
  "## Memory",
  "",
  "This project uses AgentMemory.",
  "- Session start: call memory_recall() without query to get recent context.",
  "- Important decisions: call memory_remember(transcript, sessionId, projectId).",
  "- Deep search: call memory_recall_deep(query, projectId, workspaceDir).",
  "- Manual cleanup: call dreaming(projectId).",
].join("\n");
injectAgentsMdAppendix(workspaceDir, appendix);

const totalFragments = results.reduce((s, r) => s + r.fragments, 0);
const errors = results.filter((r) => r.error);

console.log("\n--- Import Complete ---");
console.log(`Files processed: ${results.length}`);
console.log(`Total fragments: ${totalFragments}`);
if (errors.length > 0) {
  console.log(`Errors: ${errors.length}`);
  for (const e of errors) {
    console.log(`  - ${e.file}: ${e.error}`);
  }
}
console.log("AgentMemory bootstrap complete.");
