import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MemoryEngine } from "../core/engine.js";
import { buildToolHandlers } from "./tools.js";
import { openDb } from "../db/connection.js";

const TOOL_DEFINITIONS = [
  {
    name: "memory_recall",
    description: "Recall relevant memories for the current context. Call without query to get recent project fragments.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search query" },
        projectId: { type: "string", description: "Project identifier" },
        workspaceDir: { type: "string", description: "Workspace directory path" },
      },
      required: ["projectId", "workspaceDir"],
    },
  },
  {
    name: "memory_remember",
    description: "Store a conversation segment as searchable memory fragments.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Conversation transcript to fragment" },
        sessionId: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["transcript", "sessionId", "projectId"],
    },
  },
  {
    name: "memory_search",
    description: "Explicit semantic search across memory fragments.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectId: { type: "string" },
        maxResults: { type: "number", default: 6 },
        minScore: { type: "number", default: 0.35 },
      },
      required: ["query", "projectId"],
    },
  },
  {
    name: "memory_get",
    description: "Read a specific memory fragment and its linked fragments.",
    inputSchema: {
      type: "object",
      properties: { fragmentId: { type: "string" } },
      required: ["fragmentId"],
    },
  },
  {
    name: "memory_store",
    description: "Store pre-fragmented memory fragments (from client-side fragmentation when no API key is configured).",
    inputSchema: {
      type: "object",
      properties: {
        fragments: { type: "array", items: { type: "object" }, description: "Array of {channel, label, weight, linkedTo, summary}" },
        sessionId: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["fragments", "sessionId", "projectId"],
    },
  },
  {
    name: "memory_recall_deep",
    description: "Deep 4-layer recall: searches active fragments, archive, transcripts, and project files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectId: { type: "string" },
        workspaceDir: { type: "string" },
      },
      required: ["query", "projectId", "workspaceDir"],
    },
  },
  {
    name: "dreaming",
    description: "Manually trigger memory cleanup and decay processing.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "memory_bootstrap",
    description: "First-run setup: scan existing memory files, estimate token cost, and optionally batch-import all memories as searchable fragments. Call without confirm to preview, then call with confirm='Y' to execute.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceDir: { type: "string", description: "Project workspace directory to scan for memory files" },
        projectId: { type: "string", description: "Project identifier" },
        confirm: { type: "string", description: "Set to 'Y' to execute the import after previewing the estimate" },
      },
      required: ["workspaceDir", "projectId"],
    },
  },
];

export async function startServer(apiKey: string, dbPath?: string) {
  openDb(dbPath);
  const baseURL = process.env.AGENTMEMORY_EMBEDDING_URL || "https://api.minimax.chat";
  const fragmentationKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  const fragmentationBaseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  const engine = new MemoryEngine({
    apiKey,
    baseURL,
    fragmentationKey,
    fragmentationBaseURL,
  });
  const handlers = buildToolHandlers(engine);

  const server = new Server(
    { name: "agentmemory", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = (handlers as Record<string, Function>)[name];
    if (!handler) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const result = await handler(args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgentMemory MCP server started");
}
