// orchestrator-worker.ts — 独立维护进程入口
// 由 SessionStart hook spawn（方案 A），跑统一记忆维护周期（MemoryOrchestrator），
// 用完即退（无常驻）。spawn 时需设置 LINGXI_HOME 指向记忆主库（~/.agentmemory）。
import { openDb } from "../db/connection.js";
import { runMemoryOrchestrator, formatOrchestratorResult } from "./orchestrator.js";

async function main(): Promise<void> {
  try {
    openDb();
    const r = await runMemoryOrchestrator();
    console.log(formatOrchestratorResult(r));
  } catch (e: any) {
    console.error("[Orchestrator] worker failed:", e?.message?.slice(0, 160));
    process.exit(1);
  }
}

void main();
