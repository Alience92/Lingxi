import { startServer } from "./mcp/server.js";

const apiKey = process.env.ANTHROPIC_API_KEY || "";
if (!apiKey) {
  console.error("Warning: No ANTHROPIC_API_KEY set. Fragmentation will be disabled (test mode).");
}

startServer(apiKey).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
