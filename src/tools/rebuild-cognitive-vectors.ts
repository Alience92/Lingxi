// rebuild-cognitive-vectors.ts — 用 cognitive_v5 重建 fragments.vector 列
// 替换 bge-m3 向量（不同空间，cosine 无意义），让 retriever 认知精筛生效。
// 运行：LINGXI_HOME=~/.agentmemory node --import tsx src/tools/rebuild-cognitive-vectors.ts

import { openDb, getDb } from "../db/connection.js";
import { encodeCognitiveBatch } from "../core/cognitive-state.js";
import { isCognitiveReady } from "../core/cognitive-state.js";

async function main(): Promise<void> {
  openDb();
  const db = getDb();

  const ready = await isCognitiveReady();
  if (!ready) {
    console.error("[RebuildVec] cognitive_v5 不可用，跳过");
    process.exit(1);
  }

  const frags = db.prepare(
    "SELECT id, summary, keywords FROM fragments ORDER BY created_at ASC"
  ).all() as Array<{ id: string; summary: string; keywords: string | null }>;

  console.log(`[RebuildVec] 开始重建 ${frags.length} 条碎片向量...`);
  const t0 = Date.now();
  const stmt = db.prepare(
    "UPDATE fragments SET vector = ?, vector_model = 'cognitive_v5' WHERE id = ?"
  );
  const BATCH = 20;
  let done = 0, failed = 0;

  for (let i = 0; i < frags.length; i += BATCH) {
    const batch = frags.slice(i, i + BATCH);
    const texts = batch.map((f) => [f.summary, f.keywords].filter(Boolean).join(" ").slice(0, 300));
    const vecs = await encodeCognitiveBatch(texts);
    const tx = db.transaction(() => {
      for (let j = 0; j < vecs.length; j++) {
        const v = vecs[j];
        if (v && v.length >= 1024) {
          const buf = Buffer.alloc(1024 * 4);
          for (let k = 0; k < 1024; k++) buf.writeFloatLE(v[k]!, k * 4);
          stmt.run(buf, batch[j]!.id);
          done++;
        } else {
          failed++;
        }
      }
    });
    tx();
    if ((i / BATCH) % 5 === 0) console.log(`[RebuildVec] ${Math.min(i + BATCH, frags.length)}/${frags.length}`);
  }

  console.log(`[RebuildVec] 完成: ${done} 成功, ${failed} 失败, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

void main();
