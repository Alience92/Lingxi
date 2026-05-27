import { startServer } from "./skill/mcp/server.js";

const apiKey = process.env.AGENTMEMORY_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || "";
if (!apiKey) {
  console.error("Warning: No AGENTMEMORY_API_KEY, DEEPSEEK_API_KEY, or ANTHROPIC_API_KEY set. Fragmentation will be disabled (test mode).");
}

startServer(apiKey).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
