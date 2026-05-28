import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MemoryEngine } from "../engine.js";
import { buildToolHandlers } from "./skill-tools.js";
import { openDb, getDb } from "../../db/connection.js";

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
        minScore: { type: "number", description: "Lower = more results. Default adapts to embedder: ~0.30 with API, ~0.12 with hash." },
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
    name: "decision_criteria_get",
    description: "Find the decision criteria for a subject — why was a certain target chosen? Returns the discriminating dimension and value.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        subject: { type: "string", description: "The subject/product/task to find criteria for" },
      },
      required: ["projectId", "subject"],
    },
  },
  {
    name: "decision_criteria_record",
    description: "Record a decision criteria — subject X goes to target Y because criteria dimension = value.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        subject: { type: "string" },
        target: { type: "string" },
        criteriaType: { type: "string", description: "The discriminating dimension, e.g. product_type" },
        criteriaValue: { type: "string", description: "The value, e.g. 标品" },
        confidence: { type: "number", description: "Confidence 0-1, default 0.8" },
        source: { type: "string", description: "'user' or 'auto', default 'user'" },
      },
      required: ["projectId", "subject", "target", "criteriaType", "criteriaValue"],
    },
  },
  {
    name: "memory_recall_event",
    description: "Reassemble a full memory event from a single fragment ID. Follows fragment links bidirectionally to reconstruct the original context. Returns a human-readable narrative.",
    inputSchema: {
      type: "object",
      properties: { fragmentId: { type: "string" } },
      required: ["fragmentId"],
    },
  },
  {
    name: "memory_recall_event_from_search",
    description: "Search for a memory and reassemble the full event context around the top result. Combines search + fragment reassembly into one call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["query", "projectId"],
    },
  },
  {
    name: "trust_profile_get",
    description: "Get the current autonomy trust profile for a project. Shows confirm/auto decision counts and current autonomy level (L1: plan-first, L2: offer-choice, L3: default-auto).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "trust_profile_record",
    description: "Record a decision outcome to update the trust profile. wasAuto=true if agent made the decision autonomously, wasCorrect=true if the decision was right.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        wasAuto: { type: "boolean" },
        wasCorrect: { type: "boolean" },
      },
      required: ["projectId", "wasAuto", "wasCorrect"],
    },
  },
  {
    name: "relationship_profile_get",
    description: "Get the current relationship profile between user and agent — friction score, autonomy budget, trust level, and recent signal counters.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier" },
        userId: { type: "string", description: "Optional user identifier (default: 'default')" },
      },
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
  {
    name: "skill_route_suggest",
    description: "Given a user intent, suggest the best skill/tool to use based on learned routing patterns.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        intent: { type: "string", description: "What the user wants to do" },
        maxSuggestions: { type: "number", default: 3 },
      },
      required: ["projectId", "intent"],
    },
  },
  {
    name: "skill_route_feedback",
    description: "Record whether a skill choice was successful or not, to improve future routing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        intent: { type: "string" },
        skillName: { type: "string" },
        wasSuccessful: { type: "boolean" },
      },
      required: ["projectId", "intent", "skillName", "wasSuccessful"],
    },
  },
  {
    name: "memory_heartbeat",
    description: "Lightweight periodic check-in. Call every 3-5 conversation turns. Returns pending memory directives, rule refreshes, and skill routing suggestions. Designed for MCP Hosts that lack hook/Resource support.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        turnCount: { type: "number", description: "Current conversation turn number" },
        lastUserMessage: { type: "string", description: "Brief summary of user's last message" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "memory_health",
    description: "Get memory system health report: fragment counts, channel balance (WHAT/FEEL/WHO/WHERE), query stats (24h), and active alerts (backlog, zero-hit rate, channel bias, dreaming stall).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Project identifier" } },
      required: ["projectId"],
    },
  },
  {
    name: "memory_alias",
    description: "Manage terminology aliases for symbol grounding. Map old terms to new canonical terms so queries using either name can find matching fragments. Example: 'MEM-SYM' -> '灵犀' so old fragments with 'MEM-SYM' are found by queries using '灵犀'.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier" },
        action: { type: "string", description: "list, add, or remove" },
        canonical: { type: "string", description: "The canonical (current/preferred) term" },
        alias: { type: "string", description: "The alias (old/alternative) term" },
      },
      required: ["projectId", "action"],
    },
  },
];

export async function startServer(apiKey: string, dbPath?: string) {
  openDb(dbPath);
  const baseURL = process.env.AGENTMEMORY_EMBEDDING_URL || "https://api.minimax.chat";
  const fragmentationKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || apiKey;
  const fragmentationBaseURL = process.env.DEEPSEEK_BASE_URL
    || (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "https://api.minimax.chat");
  const engine = new MemoryEngine({
    apiKey,
    baseURL,
    fragmentationKey,
    fragmentationBaseURL,
  });
  const handlers = buildToolHandlers(engine);

  const server = new Server(
    { name: "agentmemory", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // MCP Resource: memory://{projectId}/session-context (auto-injected by Host each turn)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const db = getDb();
    const projects = db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
    return {
      resources: projects.map(p => ({
        uri: `memory://${p.id}/session-context`,
        name: `Agent Memory Context (${p.id})`,
        description: `Auto-injected memory context for project ${p.id}: L0 rules, pending directives`,
        mimeType: "text/plain",
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const db = getDb();
    // Extract projectId from URI: memory://{projectId}/session-context
    const uri = request.params.uri;
    const match = uri.match(/^memory:\/\/([^/]+)\/session-context$/);
    const primaryProject = match ? match[1]! : null;

    if (!primaryProject) {
      return { contents: [{ uri, mimeType: "text/plain", text: "Invalid resource URI. Use memory://{projectId}/session-context" }] };
    }

    // L0 rules
    const rules = db.prepare(`
      SELECT dr.text FROM distilled_rules dr
      JOIN rule_sources rs ON rs.rule_id = dr.id
      WHERE rs.project_id = ? OR rs.project_id IN (
        SELECT DISTINCT project_id FROM rule_sources WHERE rule_id = dr.id
      )
      GROUP BY dr.id ORDER BY dr.weight DESC LIMIT 5
    `).all(primaryProject) as Array<{ text: string }>;

    // Pending check
    const pending = db.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ? AND pending_fragmentation > 0"
    ).get(primaryProject) as { cnt: number };

    const parts: string[] = [];
    if (rules.length > 0) {
      parts.push("## L0 Rules\n" + rules.map(r => `- ${r.text}`).join("\n"));
    }
    if (pending.cnt > 0) {
      parts.push(`> 上一段对话还在消化中（${pending.cnt} 个会话待处理）`);
    }
    parts.push("> Use memory_recall() for active context, memory_search() for deep lookup.");

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "text/plain",
        text: parts.join("\n\n"),
      }],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Each handler has its own typed params — the catch below handles runtime mismatches
    const handler = (handlers as unknown as Record<string, (args: Record<string, unknown>) => unknown>)[name];
    if (!handler) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    // Validate required arguments against tool inputSchema
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
    if (toolDef?.inputSchema?.required) {
      const missing = (toolDef.inputSchema.required as string[]).filter(r => !(r in (args ?? {})));
      if (missing.length > 0) {
        return { content: [{ type: "text", text: `Missing required arguments: ${missing.join(", ")}` }], isError: true };
      }
    }
    try {
      const result = await handler(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Tool error: ${(e as Error).message?.slice(0, 200)}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgentMemory MCP server started");
}
