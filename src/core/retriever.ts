import type { Fragment, SearchResult, PrefetchResult, SessionContext } from "../types.js";
import { getDb } from "../db/connection.js";
import { getCurrentEmbedder, cosineSimilarity } from "./embedder.js";

const API_MIN_SCORE = 0.30;
const HASH_MIN_SCORE = 0.12;
const DEFAULT_MAX_RESULTS = 6;

function getDefaultMinScore(): number {
  try {
    return getCurrentEmbedder().isHashOnly() ? HASH_MIN_SCORE : API_MIN_SCORE;
  } catch {
    return HASH_MIN_SCORE;
  }
}

export const DEFAULT_MIN_SCORE = API_MIN_SCORE; // legacy constant for external callers
// Prefetch MMR diversity threshold — independent of search minScore to keep filtering strict
const PREFETCH_MMR_MIN_SCORE = 0.18;
const PREFETCH_MMR_PENALTY_FACTOR = 0.6;
// ~150 tokens ≈ 450 chars for CJK, 600 for English
const PREFETCH_BUDGET_CHARS = 450;

// ── Prefetch timing instrumentation ──────────────────────────────────

export interface PrefetchTiming {
  embedMs: number;
  vectorSearchMs: number;
  mmrMs: number;
  totalMs: number;
  cacheHits: number;
  cacheMisses: number;
  candidatesFound: number;
  selectedCount: number;
}

let _lastPrefetchTiming: PrefetchTiming | null = null;
export function getLastPrefetchTiming(): PrefetchTiming | null {
  return _lastPrefetchTiming;
}

const PERF_TIMING = process.env.AGENTMEMORY_PERF_TIMING === "1";

// ── P2: Silent associative prefetch with anchor weighting + cluster + MMR

export async function prefetch(
  messages: SessionContext["lastMessages"],
  projectId: string
): Promise<PrefetchResult> {
  const t0 = Date.now();
  if (messages.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  const queryText = messages.slice(-3).map((m) => m.text).join("\n");
  const embedder = getCurrentEmbedder();
  const queryVec = await embedder.embed(queryText, "query");
  const tEmbed = Date.now();

  // Get more candidates for reranking — also get the per-query embedding cache
  const { results: candidates, cache, cacheHits, cacheMisses } = await vectorSearch(queryVec, projectId, 20, getDefaultMinScore() * 0.6);
  const tSearch = Date.now();

  if (candidates.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  // Rerank: composite score = vector × anchor_weight × decay_score
  const reranked = candidates.map((r) => {
    const maxAnchorWeight = Math.max(...r.fragment.anchors.map((a) => a.weight), 10) / 255;
    const compositeScore = r.score * 0.5 + maxAnchorWeight * 0.3 + r.fragment.decayScore * 0.2;
    return { ...r, compositeScore };
  }).sort((a, b) => b.compositeScore - a.compositeScore);

  // MMR: prefer diverse results — penalize fragments too similar to already-selected
  const selected: typeof reranked = [];
  const usedIds = new Set<string>();

  for (const candidate of reranked) {
    if (usedIds.has(candidate.fragment.id)) continue;
    if (selected.length >= 3) break;

    // MMR penalty: reuse cached embeddings from vectorSearch
    let mmrPenalty = 0;
    let maxSim = 0;
    const candVec = cache.get(candidate.fragment.id);
    for (const sel of selected) {
      const selVec = cache.get(sel.fragment.id);
      if (!candVec || !selVec) continue;
      const sim = cosineSimilarity(candVec, selVec);
      maxSim = Math.max(maxSim, sim);
      mmrPenalty = Math.max(mmrPenalty, sim * PREFETCH_MMR_PENALTY_FACTOR);
    }
    if (maxSim > 0.95 && selected.length > 0) continue;
    const mmrScore = candidate.compositeScore - mmrPenalty;
    if (mmrScore < PREFETCH_MMR_MIN_SCORE && selected.length > 0) continue;

    selected.push(candidate);
    usedIds.add(candidate.fragment.id);
    for (const linkedId of candidate.fragment.linkedIds) {
      usedIds.add(linkedId);
    }
  }
  const tMMR = Date.now();

  // Build context block within token budget
  let block = "";
  const fragmentIds: string[] = [];
  for (const r of selected) {
    const anchor = r.fragment.anchors[0];
    const channel = anchor ? anchor.channel : "WHAT";
    const maxWeight = Math.max(...r.fragment.anchors.map((a) => a.weight));
    const signal = maxWeight > 50 ? "⚡" : "";
    const candidate = `${signal}[${channel}] ${r.fragment.summary}`;
    if (block.length + candidate.length + 2 <= PREFETCH_BUDGET_CHARS) {
      block = block ? `${block}\n${candidate}` : candidate;
      fragmentIds.push(r.fragment.id);
    }
  }

  const confidence = selected.length > 0 ? Math.min(0.9, selected[0]?.compositeScore ?? 0) : 0;
  const tTotal = Date.now();

  _lastPrefetchTiming = {
    embedMs: tEmbed - t0,
    vectorSearchMs: tSearch - tEmbed,
    mmrMs: tMMR - tSearch,
    totalMs: tTotal - t0,
    cacheHits,
    cacheMisses,
    candidatesFound: candidates.length,
    selectedCount: selected.length,
  };

  if (PERF_TIMING) {
    console.error(`[AgentMemory] prefetch timing: embed=${tEmbed - t0}ms search=${tSearch - tEmbed}ms mmr=${tMMR - tSearch}ms total=${tTotal - t0}ms | cache hits=${cacheHits} misses=${cacheMisses} | candidates=${candidates.length} selected=${selected.length}`);
  }

  return { contextBlock: block, fragmentIds, confidence };
}

// P3: Explicit search
export async function explicitSearch(
  query: string,
  projectId: string,
  minScore?: number,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<SearchResult[]> {
  minScore = minScore ?? getDefaultMinScore();
  const queryVec = await getCurrentEmbedder().embed(query, "query");
  const { results } = await vectorSearch(queryVec, projectId, maxResults, minScore, {
    recallMode: "explicit",
    query,
  });
  return results;
}

interface SearchOptions {
  recallMode?: "prefetch" | "explicit";
  query?: string;
}

interface VectorSearchResult {
  results: SearchResult[];
  cache: Map<string, number[]>;  // fragmentId → embedding vector
  cacheHits: number;
  cacheMisses: number;
}

async function vectorSearch(
  queryVec: number[],
  projectId: string,
  limit: number,
  minScore: number,
  options: SearchOptions = {}
): Promise<VectorSearchResult> {
  const db = getDb();
  const recallMode = options.recallMode ?? "prefetch";
  const originalQuery = options.query ?? "";
  const embedder = getCurrentEmbedder();

  const rawRows = db.prepare(`
    SELECT * FROM fragments
    WHERE project_id = ? AND status = 'active' AND decay_score > 0
  `).all(projectId) as Array<Record<string, unknown>>;

  if (rawRows.length === 0) {
    return { results: [], cache: new Map(), cacheHits: 0, cacheMisses: 0 };
  }

  const allIds = rawRows.map((r) => r.id as string);

  // Batch-load anchors and links (3 queries total instead of 2N)
  const anchorMap = new Map<string, Array<{ channel: string; label: string; weight: number; source: string; timestamp: number }>>();
  const linkMap = new Map<string, string[]>();

  const anchorRows = db.prepare(`
    SELECT fragment_id, channel, label, weight, source, timestamp
    FROM fragment_anchors WHERE fragment_id IN (${allIds.map(() => "?").join(",")})
  `).all(...allIds) as Array<{ fragment_id: string; channel: string; label: string; weight: number; source: string; timestamp: number }>;

  for (const a of anchorRows) {
    if (!anchorMap.has(a.fragment_id)) anchorMap.set(a.fragment_id, []);
    anchorMap.get(a.fragment_id)!.push(a);
  }

  const linkRows = db.prepare(`
    SELECT source_id, target_id FROM fragment_links
    WHERE source_id IN (${allIds.map(() => "?").join(",")})
  `).all(...allIds) as Array<{ source_id: string; target_id: string }>;

  for (const l of linkRows) {
    if (!linkMap.has(l.source_id)) linkMap.set(l.source_id, []);
    linkMap.get(l.source_id)!.push(l.target_id);
  }

  // Per-query embedding cache
  const cache = new Map<string, number[]>();
  const persistedVectors = new Map<string, number[]>();
  let cacheHits = 0;
  let cacheMisses = 0;

  // Build fragment objects with batched anchors/links
  const rows: Fragment[] = [];
  for (const r of rawRows) {
    const id = r.id as string;
    if (r.vector instanceof Buffer && r.vector.length >= 4) {
      const floats = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.length / 4);
      persistedVectors.set(id, Array.from(floats));
    }

    const anchors = anchorMap.get(id) ?? [];
    const linkedIds = linkMap.get(id) ?? [];

    rows.push({
      id,
      sessionId: r.session_id as string,
      projectId: r.project_id as string,
      summary: r.summary as string,
      linkedCount: r.linked_count as number,
      decayScore: r.decay_score as number,
      lastRecalledAt: r.last_recalled_at as number | null,
      recalledCount: r.recalled_count as number,
      createdAt: r.created_at as number,
      status: r.status as "active" | "archived" | "deleted",
      anchors: anchors.map((a) => ({
        channel: a.channel as import("../types.js").Channel,
        label: a.label,
        weight: a.weight,
        source: a.source as import("../types.js").SignalSource,
        timestamp: a.timestamp,
      })),
      linkedIds,
    });
  }

  // Batch-embed fragments without persisted vectors (1 API call vs N)
  const missingIds: string[] = [];
  const missingTexts: string[] = [];
  for (const fragment of rows) {
    const persisted = persistedVectors.get(fragment.id);
    if (persisted) {
      cache.set(fragment.id, persisted);
      cacheHits++;
    } else {
      missingIds.push(fragment.id);
      missingTexts.push(fragment.summary);
    }
  }

  if (missingTexts.length > 0) {
    const batchVecs = await embedder.embedBatch(missingTexts, "store");
    for (let i = 0; i < missingIds.length; i++) {
      cache.set(missingIds[i]!, batchVecs[i]!);
      cacheMisses++;
    }
  }

  const results: SearchResult[] = [];
  const hitIds = new Set<string>();

  for (const fragment of rows) {
    const fragVec = cache.get(fragment.id)!;
    const score = cosineSimilarity(queryVec, fragVec);

    if (score >= minScore) {
      hitIds.add(fragment.id);
      results.push({
        fragment,
        score,
        matchedAnchors: fragment.linkedIds,
        missingLinks: 0,
      });

      if (recallMode === "explicit" && originalQuery) {
        db.prepare(`INSERT INTO recall_log (fragment_id, query, score, recalled_at) VALUES (?, ?, ?, ?)`).run(
          fragment.id, originalQuery, score, Date.now()
        );
        db.prepare(`UPDATE fragments SET decay_score = 1.0, last_recalled_at = ?, recalled_count = recalled_count + 1 WHERE id = ?`).run(
          Date.now(), fragment.id
        );
      }
    }
  }

  // Compute missingLinks from preloaded link map (no extra queries)
  for (const result of results) {
    const linkedIds = linkMap.get(result.fragment.id) ?? [];
    const missedLinks = linkedIds.filter((lid) => !hitIds.has(lid));
    result.missingLinks = missedLinks.length;
    result.matchedAnchors = linkedIds.filter((lid) => hitIds.has(lid));
  }

  return {
    results: results.sort((a, b) => b.score - a.score).slice(0, limit),
    cache,
    cacheHits,
    cacheMisses,
  };
}
