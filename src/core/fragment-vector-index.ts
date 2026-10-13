// fragment-vector-index.ts — 碎片向量索引
// 启动时装载所有碎片的 cognitive_v5 向量到内存，查询时直接余弦相似度检索。
// 优先复用 fragments.vector 已落库的向量；仅对缺失/异源的碎片做一次编码。
// 给 DCGK 语义路径兜底：当 evidence 边缺失时，向量路径仍然能召回碎片。

import { getDb } from "../db/connection.js";
import { cosineSimilarity, getCurrentEmbedder, COGNITIVE_DIM, COGNITIVE_MODEL_NAME } from "./embedder.js";

// ── In-memory index state ──────────────────
interface IndexEntry {
  fragmentId: string;
  summary: string;
  embedding: number[]; // cognitive_v5 1024-dim
}

let index: IndexEntry[] | null = null;
let buildTimeMs = 0;
let isBuilding = false;
let indexMode: "unavailable" | "cognitive" = "unavailable";
let indexModel = "";
let indexProjectId = "";
let indexProfileId = "";

function getCurrentProfileId(): string {
  return process.env.LINGXI_PROFILE_ID || "user_default";
}

export interface VectorSearchResult {
  fragmentId: string;
  summary: string;
  score: number; // 0-1 cosine similarity
}

export function getIndexStats(): {
  entryCount: number;
  buildTimeMs: number;
  mode: "unavailable" | "cognitive";
  model: string;
} {
  return { entryCount: index?.length ?? 0, buildTimeMs, mode: indexMode, model: indexModel };
}

export function isIndexReady(): boolean {
  return index !== null && index.length > 0;
}

// ── Vector decoding ──────────────────────────

/** fragments.vector 是 little-endian float32 串（cognitive_v5，1024 维）。 */
function decodeVector(buf: Buffer | null | undefined): number[] | null {
  if (!buf || buf.length < COGNITIVE_DIM * 4) return null;
  const out = new Array<number>(COGNITIVE_DIM);
  for (let i = 0; i < COGNITIVE_DIM; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// ── Build ────────────────────────────────────

export async function buildVectorIndex(projectId: string): Promise<{ entryCount: number; buildTimeMs: number }> {
  if (isBuilding) return { entryCount: index?.length ?? 0, buildTimeMs };
  isBuilding = true;
  const t0 = Date.now();
  const db = getDb();
  const profileId = getCurrentProfileId();

  const rows = db.prepare(`
    SELECT id, summary, vector, vector_model FROM fragments
    WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
      AND profile_id = ?
      AND id NOT LIKE 'reflect_%'
      AND session_id != 'reflection_cycle'
    ORDER BY created_at DESC LIMIT 500
  `).all(projectId, profileId) as Array<{
    id: string;
    summary: string;
    vector: Buffer | null;
    vector_model: string | null;
  }>;

  if (rows.length === 0) {
    indexMode = "unavailable";
    indexModel = "";
    isBuilding = false;
    return { entryCount: 0, buildTimeMs: 0 };
  }

  // 优先复用已落库的 cognitive_v5 向量；vector_model 不匹配或缺失的才需要编码。
  const embeddings: (number[] | null)[] = rows.map((r) =>
    r.vector_model === COGNITIVE_MODEL_NAME ? decodeVector(r.vector) : null
  );

  const missing: number[] = [];
  for (let i = 0; i < embeddings.length; i++) {
    if (!embeddings[i]) missing.push(i);
  }

  if (missing.length === 0) {
    // 全部命中存量向量 —— 无需加载模型，这条路径是常态。
    indexMode = "cognitive";
    indexModel = COGNITIVE_MODEL_NAME;
  } else {
    const reused = rows.length - missing.length;
    try {
      const embedder = getCurrentEmbedder();
      const texts = missing.map((i) => rows[i]!.summary.slice(0, 200));
      const fresh = await embedder.embedBatch(texts, "store");
      if (!fresh || fresh.length !== missing.length) throw new Error("batch length mismatch");
      missing.forEach((rowIdx, k) => { embeddings[rowIdx] = fresh[k]!; });
      indexMode = "cognitive";
      indexModel = embedder.model;
      if (reused > 0) {
        console.log(`  [VectorIdx] Encoded ${missing.length} fragment(s) lacking cognitive_v5 vectors; reused ${reused} stored.`);
      }
    } catch (e: any) {
      const msg = (e as Error).message?.slice(0, 70) ?? String(e);
      if (reused === 0) {
        // 既无存量向量、又无法编码 —— 语义索引不可用。诚实上报，不伪造。
        isBuilding = false;
        indexMode = "unavailable";
        indexModel = "";
        console.log(`  [VectorIdx] Semantic index unavailable — no stored vectors and encoding failed (${msg})`);
        return { entryCount: 0, buildTimeMs: Date.now() - t0 };
      }
      // 部分可用：继续用存量向量，明确告知缺口。
      console.log(`  [VectorIdx] Encoding unavailable (${msg}); using ${reused}/${rows.length} stored vectors, ${missing.length} fragment(s) skipped.`);
    }
  }

  index = rows
    .map((r, i) => ({ fragmentId: r.id, summary: r.summary, embedding: embeddings[i]! }))
    .filter((e) => Array.isArray(e.embedding) && e.embedding.length > 0);

  buildTimeMs = Date.now() - t0;
  indexProjectId = projectId;
  indexProfileId = profileId;
  isBuilding = false;
  console.log(`  [VectorIdx] Built: ${index.length} fragments in ${buildTimeMs}ms (${indexMode}, ${indexModel})`);
  return { entryCount: index.length, buildTimeMs };
}

// ── Search ───────────────────────────────────

export async function vectorSearch(
  query: string,
  topK: number = 20,
): Promise<VectorSearchResult[]> {
  const projectId = process.env.LINGXI_PROJECT_ID || "C--Users-Administrator";
  const profileId = getCurrentProfileId();
  if (!index || index.length === 0 || indexProjectId !== projectId || indexProfileId !== profileId) {
    await buildVectorIndex(projectId);
  }
  if (!index || index.length === 0) return [];

  const queryEmb = await embedSingle(query);
  if (!queryEmb) return [];

  // Cosine similarity against all fragments
  const scored: VectorSearchResult[] = [];
  for (const entry of index) {
    const score = cosineSimilarity(queryEmb, entry.embedding);
    if (score > 0.50) { // minimum relevance threshold
      scored.push({
        fragmentId: entry.fragmentId,
        summary: entry.summary,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ── Evidence Bridge: Vector → DCGK ───────────

/**
 * Auto-create evidence edges from vector search results into DCGK.
 * This is the bridge that lets the graph grow from data rather than manual seeding.
 *
 * For each top result, checks if an evidence edge already exists from any DCGK node
 * to the fragment. If not, creates one with low initial weight.
 *
 * Call from shadow collector after each shadowLearn cycle.
 */
export function autoEvidenceBridge(
  query: string,
  results: VectorSearchResult[],
  projectId: string,
): { created: number; skipped: number } {
  if (results.length === 0) return { created: 0, skipped: 0 };

  try {
    const db = getDb();
    let created = 0, skipped = 0;

    // Create a concept node for this query if it doesn't exist
    const nodeId = `auto_${query.slice(0, 30).replace(/[^a-zA-Z0-9一-鿿]/g, "_")}`;
    const exists = db.prepare("SELECT id FROM dcgk_nodes WHERE id = ?").get(nodeId);
    if (!exists) {
      db.prepare(`INSERT OR IGNORE INTO dcgk_nodes (id, label, activation, confidence, plasticity, last_updated, project_id)
        VALUES (?, ?, 0.3, 0.3, 0.5, ?, ?)`)
        .run(nodeId, `[自动] ${query.slice(0, 60)}`, Date.now(), projectId);
    }

    for (const r of results.slice(0, 3)) {
      if (r.score < 0.60) continue; // Only strong matches

      // Check if evidence edge already exists
      const edgeExists = db.prepare(
        "SELECT 1 FROM dcgk_edges WHERE source_id = ? AND target_id = ? AND etype = 'evidence'"
      ).get(nodeId, r.fragmentId);

      if (!edgeExists) {
        db.prepare(`INSERT OR IGNORE INTO dcgk_edges (source_id, target_id, weight, etype, eligibility_trace, last_updated, project_id)
          VALUES (?, ?, ?, 'evidence', ?, ?, ?)`)
          .run(nodeId, r.fragmentId, r.score * 0.3, r.score * 0.1, Date.now(), projectId);
        created++;
      } else {
        skipped++;
      }
    }

    if (created > 0) {
      console.log(`  [EvidenceBridge] ${created} new evidence edges created from vector search (${skipped} already existed)`);
    }
    return { created, skipped };
  } catch (e: any) {
    console.log(`  [EvidenceBridge] Error: ${e.message}`);
    return { created: 0, skipped: 0 };
  }
}

// ── Embedding helpers ────────────────────────

/** 查询向量必须现算（查询文本不在库里）。 */
async function embedSingle(text: string): Promise<number[] | null> {
  try {
    const embedder = getCurrentEmbedder();
    indexModel = embedder.model;
    return await embedder.embed(text, "query");
  } catch {
    return null;
  }
}
