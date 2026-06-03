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
// ~200 tokens ≈ 600 chars for CJK
const PREFETCH_BUDGET_CHARS = 600;

// ── IDF cache for keyword selection ──────────────────────────────────
// Maps projectId → { df: bigram→document-frequency, fragmentCount: N }
// Rebuilt when active fragment count changes. Avoids a bigram_stats DB table.

const _dfCaches = new Map<string, { df: Map<string, number>; fragmentCount: number }>();

function buildDFCache(projectId: string): Map<string, number> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT summary FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' AND decay_score > 0"
  ).all(projectId) as Array<{ summary: string }>;

  const df = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set<string>();
    const text = row.summary;
    // CJK bigrams
    for (let i = 0; i < text.length - 1; i++) {
      const bg = text.slice(i, i + 2);
      if (/[一-鿿]/.test(bg[0]!) && /[一-鿿]/.test(bg[1]!)) {
        if (!seen.has(bg)) { seen.add(bg); df.set(bg, (df.get(bg) ?? 0) + 1); }
      }
    }
    // Alpha tokens
    const alphaToks = text.match(/[a-zA-Z0-9_]{2,}/g) || [];
    for (const tok of alphaToks) {
      const lower = tok.toLowerCase();
      if (!seen.has(lower)) { seen.add(lower); df.set(lower, (df.get(lower) ?? 0) + 1); }
    }
  }
  return df;
}

function getDFCache(projectId: string): Map<string, number> {
  const db = getDb();
  const currentCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' AND decay_score > 0"
  ).get(projectId) as { cnt: number }).cnt;

  const cached = _dfCaches.get(projectId);
  if (cached && cached.fragmentCount === currentCount) {
    return cached.df;
  }
  const df = buildDFCache(projectId);
  _dfCaches.set(projectId, { df, fragmentCount: currentCount });
  return df;
}

// ── Alias expansion for symbol grounding ─────────────────────────────

function expandQueryForProject(query: string, projectId: string): string {
  const db = getDb();
  const aliases = db.prepare(
    "SELECT canonical, alias FROM aliases WHERE project_id = ? AND confidence >= 0.7"
  ).all(projectId) as Array<{ canonical: string; alias: string }>;
  let expanded = query;
  for (const a of aliases) {
    if (expanded.includes(a.canonical) && !expanded.includes(a.alias)) {
      expanded = `${expanded} ${a.alias}`;
    }
    if (expanded.includes(a.alias) && !expanded.includes(a.canonical)) {
      expanded = `${a.canonical} ${expanded}`;
    }
  }
  return expanded;
}

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

  const rawQueryText = messages.slice(-3).map((m) => m.text).join("\n");
  const queryText = expandQueryForProject(rawQueryText, projectId);
  const embedder = getCurrentEmbedder();
  const queryVec = await embedder.embed(queryText, "query");
  const tEmbed = Date.now();

  // Get more candidates for reranking — also get the per-query embedding cache
  const { results: candidates, cache, cacheHits, cacheMisses } = await vectorSearch(queryVec, projectId, 20, getDefaultMinScore() * 0.6);
  const tSearch = Date.now();

  if (candidates.length === 0) {
    // B→A→C: B=context (already searched), A=L3 fallback, C=digesting hint
    const db = getDb();
    const pendingCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ? AND pending_fragmentation > 0"
    ).get(projectId) as { cnt: number }).cnt;

    if (pendingCount > 0) {
      return {
        contextBlock: "[AgentMemory] 上一段对话还在消化中，大约需要半分钟。",
        fragmentIds: [],
        confidence: 0.1,
      };
    }

    // L3 fallback: search raw transcripts when no fragments exist
    try {
      const { fourLayerRecall } = await import("./backup-recall.js");
      const project = db.prepare("SELECT workspace_dir FROM projects WHERE id = ?").get(projectId) as { workspace_dir: string } | undefined;
      if (project?.workspace_dir) {
        const recall = await fourLayerRecall(queryText, projectId, project.workspace_dir);
        if (recall.fragments.length > 0) {
          const summaries = recall.fragments.slice(0, 3).map(r => `[${recall.source}] ${r.fragment.summary}`).join("\n");
          return { contextBlock: summaries, fragmentIds: recall.fragments.map(r => r.fragment.id), confidence: 0.3 };
        }
      }
    } catch (e) {
      console.error("[AgentMemory] backup recall failed:", (e as Error).message?.slice(0, 80));
    }

    return { contextBlock: "", fragmentIds: [], confidence: 0 };
  }

  // Rerank: composite score = vector × anchor_weight × decay_score +
  //         scope bonus (matching scope or global gets +0.05)
  const projectScope = `project:${projectId}`;
  const reranked = candidates.map((r) => {
    const maxAnchorWeight = Math.max(...r.fragment.anchors.map((a) => a.weight), 10) / 255;
    let compositeScore = r.score * 0.5 + maxAnchorWeight * 0.3 + r.fragment.decayScore * 0.2;
    if (!r.fragment.scope || r.fragment.scope === projectScope) {
      compositeScore += 0.05; // matching scope or global — small boost
    }
    return { ...r, compositeScore };
  }).sort((a, b) => b.compositeScore - a.compositeScore);

  // MMR: prefer diverse results — penalize fragments too similar to already-selected
  const selected: typeof reranked = [];
  const usedIds = new Set<string>();

  for (const candidate of reranked) {
    if (usedIds.has(candidate.fragment.id)) continue;
    if (selected.length >= 5) break;

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

  // ── Knowledge edge augmentation ──────────────────────────
  // For each selected fragment, query corrected_by and distilled_from
  // edges to find causally related fragments that keyword+vector search misses.
  const augmentedIds = new Set(selected.map(r => r.fragment.id));
  if (selected.length > 0) {
    try {
      const db = getDb();
      for (const r of selected) {
        // corrected_by: FEEL corrections from same session → WHAT fragments
        const feelAnchors = r.fragment.anchors.filter(a => a.channel === "FEEL" && a.weight >= 80);
        if (feelAnchors.length > 0) {
          const peers = db.prepare(`
            SELECT f.id, f.summary, f.decay_score FROM fragments f
            WHERE f.project_id = ? AND f.session_id = ? AND f.id != ?
              AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted'
            ORDER BY f.decay_score DESC LIMIT 3
          `).all(r.fragment.projectId, r.fragment.sessionId, r.fragment.id) as Array<{ id: string; summary: string; decay_score: number }>;
          for (const p of peers) augmentedIds.add(p.id);
        }
        // distilled_from: if this fragment was distilled to a rule, add sibling source fragments
        if (r.fragment.distilledTo) {
          const siblings = db.prepare(`
            SELECT rs.fragment_id as id FROM rule_sources rs
            JOIN fragments f ON f.id = rs.fragment_id
            WHERE rs.rule_id = ? AND f.id != ?
              AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted'
            LIMIT 3
          `).all(r.fragment.distilledTo, r.fragment.id) as Array<{ id: string }>;
          for (const s of siblings) augmentedIds.add(s.id);
        }
      }
    } catch { /* edge augmentation is best-effort, never block prefetch */ }
  }

  // Build context block within token budget — including augmented fragments
  let block = "";
  const fragmentIds: string[] = [];
  // First pass: selected (MMR-ranked) fragments
  for (const r of selected) {
    const anchor = r.fragment.anchors[0];
    const channel = anchor ? anchor.channel : "WHAT";
    const maxWeight = Math.max(...r.fragment.anchors.map((a) => a.weight), 0);
    const signal = maxWeight > 50 ? "⚡" : "";
    const candidate = `${signal}[${channel}] ${r.fragment.summary}`;
    if (block.length + candidate.length + 2 <= PREFETCH_BUDGET_CHARS) {
      block = block ? `${block}\n${candidate}` : candidate;
      fragmentIds.push(r.fragment.id);
    }
  }
  // Second pass: augmented edge fragments (only if budget remains)
  for (const id of augmentedIds) {
    if (fragmentIds.includes(id)) continue;
    const edgeFrag = candidates.find(c => c.fragment.id === id)?.fragment;
    if (!edgeFrag) continue;
    const channel = edgeFrag.anchors[0]?.channel ?? "WHAT";
    const candidate = `[${channel}] ${edgeFrag.summary}`;
    if (block.length + candidate.length + 2 <= PREFETCH_BUDGET_CHARS && fragmentIds.length < 8) {
      block = block ? `${block}\n${candidate}` : candidate;
      fragmentIds.push(id);
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

  // Activation logging: record fragment retrievals for persistent state tracking
  try {
    const db = getDb();
    const qHash = String(queryText.length * 31 + queryText.charCodeAt(0));
    const now = Date.now();
    const log = db.prepare(`INSERT INTO activation_log (fragment_id, query_hash, activated_at) VALUES (?, ?, ?)`);
    for (const id of fragmentIds) {
      log.run(id, qHash, now);
    }
  } catch {}

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
  const expandedQuery = expandQueryForProject(query, projectId);
  const queryVec = await getCurrentEmbedder().embed(expandedQuery, "query");
  const { results } = await vectorSearch(queryVec, projectId, maxResults, minScore, {
    recallMode: "explicit",
    query: expandedQuery,
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

  // L1: Keyword coarse filter — extract terms, use LIKE to narrow candidates
  let rawRows: Array<Record<string, unknown>>;
  if (originalQuery) {
    // Extract CJK bigrams + alphanumeric tokens as search terms
    const cleaned = originalQuery.replace(/[，。！？、；：""''（）\s]+/g, "");
    const alphaTokens = [...new Set(originalQuery.match(/[a-zA-Z0-9_]{2,}/g) || [])];
    const cjkBigrams: string[] = [];
    const seenCjk = new Set<string>();
    for (let i = 0; i < cleaned.length - 1; i++) {
      const pair = cleaned.slice(i, i + 2);
      if (/[一-鿿]/.test(pair[0]!) && /[一-鿿]/.test(pair[1]!)) {
        if (!seenCjk.has(pair)) { seenCjk.add(pair); cjkBigrams.push(pair); }
      }
    }

    // P0+P2: Alpha tokens first (most discriminative), then CJK bigrams ranked by IDF (rarest first)
    const df = getDFCache(projectId);
    const totalDocs = (db.prepare(
      "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' AND decay_score > 0"
    ).get(projectId) as { cnt: number }).cnt;
    const idfRankedCjk = cjkBigrams
      .filter(t => df.has(t))
      .sort((a, b) => (df.get(a) ?? totalDocs) - (df.get(b) ?? totalDocs));
    // Novel terms (not in any fragment) are least useful — put them last
    const novelCjk = cjkBigrams.filter(t => !df.has(t));
    const bestCjk = [...idfRankedCjk, ...novelCjk].slice(0, 12 - alphaTokens.length);
    const uniqueTerms = [...alphaTokens.slice(0, 12), ...bestCjk].slice(0, 12);

    // Try FTS5 full-text match first for alpha tokens (best tokenization).
    // CJK bigrams fall back to LIKE (FTS5 unicode61 tokenizer can't handle bigram matching).
    rawRows = [];
    let ftsAttempted = false;
    if (alphaTokens.length > 0) {
      const ftsQuery = alphaTokens.map(t => `"${t}"`).join(" OR ");
      try {
        rawRows = db.prepare(`
          SELECT f.* FROM fragments f
          JOIN fragments_fts fts ON fts.rowid = f.rowid
          WHERE f.project_id = ? AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted' AND f.decay_score > 0
            AND fragments_fts MATCH ?
          LIMIT 500
        `).all(projectId, ftsQuery) as Array<Record<string, unknown>>;
        ftsAttempted = true;
      } catch {
        // FTS5 parse error (special chars) — fall through to LIKE
      }
    }
    if (!ftsAttempted) {
      if (uniqueTerms.length > 0) {
        const likeClauses = uniqueTerms.map(() => "summary LIKE ?").join(" OR ");
        const likeParams = uniqueTerms.map(t => `%${t}%`);
        rawRows = db.prepare(`
          SELECT * FROM fragments
          WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' AND decay_score > 0
            AND (${likeClauses})
          LIMIT 500
        `).all(projectId, ...likeParams) as Array<Record<string, unknown>>;
      } else {
        rawRows = db.prepare(`
          SELECT * FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' AND decay_score > 0
        `).all(projectId) as Array<Record<string, unknown>>;
      }
    }
  } else {
    rawRows = db.prepare(`
      SELECT * FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' AND decay_score > 0
    `).all(projectId) as Array<Record<string, unknown>>;
  }

  // Fallback: if keyword filter returned too few, retry with full scan
  if (rawRows.length < 3 && originalQuery) {
    rawRows = db.prepare(`
      SELECT * FROM fragments WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' AND decay_score > 0
    `).all(projectId) as Array<Record<string, unknown>>;
  }

  if (rawRows.length === 0) {
    return { results: [], cache: new Map(), cacheHits: 0, cacheMisses: 0 };
  }

  const allIds = rawRows.map((r) => r.id as string);

  // Batch-load anchors and links (3 queries total instead of 2N)
  const anchorMap = new Map<string, Array<{ channel: string; label: string; weight: number; source: string; timestamp: number }>>();
  const linkMap = new Map<string, string[]>();

  // SQLite default max bound params is 999; paginate if needed
  const MAX_BIND = 900;
  let anchorRows: Array<{ fragment_id: string; channel: string; label: string; weight: number; source: string; timestamp: number }> = [];
  let allLinks: Array<{ source_id: string; target_id: string }> = [];

  for (let offset = 0; offset < allIds.length; offset += MAX_BIND) {
    const batch = allIds.slice(offset, offset + MAX_BIND);
    const placeholders = batch.map(() => "?").join(",");

    const aRows = db.prepare(`
      SELECT fragment_id, channel, label, weight, source, timestamp
      FROM fragment_anchors WHERE fragment_id IN (${placeholders})
    `).all(...batch) as Array<{ fragment_id: string; channel: string; label: string; weight: number; source: string; timestamp: number }>;
    anchorRows.push(...aRows);

    const lRows = db.prepare(`
      SELECT source_id, target_id FROM fragment_links
      WHERE source_id IN (${placeholders})
    `).all(...batch) as Array<{ source_id: string; target_id: string }>;
    allLinks.push(...lRows);
  }

  for (const a of anchorRows) {
    if (!anchorMap.has(a.fragment_id)) anchorMap.set(a.fragment_id, []);
    anchorMap.get(a.fragment_id)!.push(a);
  }

  for (const l of allLinks) {
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
      retrievalState: (r.retrieval_state as "active" | "warm" | "archived" | "cold") ?? "warm",
      assetState: (r.asset_state as "retained" | "exportable" | "user_deleted") ?? "retained",
      distilledTo: r.distilled_to as string | undefined,
      scope: (r.scope as string) || null,
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

  // Record query event for accurate zero-hit stats (before limit truncation)
  if (originalQuery) {
    db.prepare(`INSERT INTO query_events (id, project_id, query, result_count, source, searched_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      `qe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      originalQuery,
      results.length,
      recallMode,
      Date.now(),
    );
  }

  return {
    results: results.sort((a, b) => b.score - a.score).slice(0, limit),
    cache,
    cacheHits,
    cacheMisses,
  };
}

// ── Memory Event Reassembly ─────────────────────────────────────────

export interface MemoryEvent {
  fragments: Array<{
    summary: string;
    channel: string;
    label: string;
    weight: number;
    timestamp: number;
  }>;
  eventSummary: string;
  fragmentCount: number;
  hasGaps: boolean;
}

const MAX_EVENT_NODES = 50;

// BFS batch bind limit (SQLite default max is 999)
const MAX_BIND = 900;

// Follow fragment_links to rebuild the full event that a fragment belongs to
export function buildMemoryEvent(fragmentId: string): MemoryEvent | null {
  const db = getDb();

  const root = db.prepare(`
    SELECT f.id, f.summary, f.created_at FROM fragments f WHERE f.id = ?
  `).get(fragmentId) as { id: string; summary: string; created_at: number } | undefined;
  if (!root) return null;

  // Collect all linked fragments via bidirectional BFS with depth limit
  const visited = new Set<string>();
  const queue = [fragmentId];
  const linkedIds: string[] = [];

  while (queue.length > 0 && linkedIds.length < MAX_EVENT_NODES) {
    // Batch: process up to MAX_BIND nodes at once, 2 queries total per batch
    const batchSize = Math.min(queue.length, MAX_BIND);
    const batch = queue.splice(0, batchSize);
    const ph = batch.map(() => "?").join(",");

    for (const nodeId of batch) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      linkedIds.push(nodeId);
    }

    if (batch.length === 0) continue;

    const outRows = db.prepare(`SELECT source_id, target_id FROM fragment_links WHERE source_id IN (${ph})`).all(...batch) as Array<{ source_id: string; target_id: string }>;
    for (const l of outRows) {
      if (!visited.has(l.target_id)) queue.push(l.target_id);
    }

    const inRows = db.prepare(`SELECT source_id, target_id FROM fragment_links WHERE target_id IN (${ph})`).all(...batch) as Array<{ source_id: string; target_id: string }>;
    for (const l of inRows) {
      if (!visited.has(l.source_id)) queue.push(l.source_id);
    }
  }

  if (linkedIds.length === 0) {
    linkedIds.push(fragmentId);
  }

  // Load anchors for all linked fragments
  const placeholders = linkedIds.map(() => "?").join(",");
  const anchors = db.prepare(`
    SELECT fa.fragment_id, fa.channel, fa.label, fa.weight, fa.timestamp, f.summary, f.created_at
    FROM fragment_anchors fa
    JOIN fragments f ON f.id = fa.fragment_id
    WHERE fa.fragment_id IN (${placeholders})
    ORDER BY f.created_at ASC
  `).all(...linkedIds) as Array<{
    fragment_id: string; channel: string; label: string; weight: number;
    timestamp: number; summary: string; created_at: number;
  }>;

  // Group by fragment
  const fragMap = new Map<string, typeof anchors>();
  for (const a of anchors) {
    if (!fragMap.has(a.fragment_id)) fragMap.set(a.fragment_id, []);
    fragMap.get(a.fragment_id)!.push(a);
  }

  const fragments = Array.from(fragMap.entries()).map(([fid, as]) => {
    const best = as.sort((a, b) => b.weight - a.weight)[0]!;
    return {
      summary: best.summary,
      channel: best.channel,
      label: best.label,
      weight: best.weight,
      timestamp: best.created_at,
    };
  }).sort((a, b) => a.timestamp - b.timestamp);

  // Check for gaps: linkedCount vs actual links
  const rootFrag = db.prepare("SELECT linked_count FROM fragments WHERE id = ?").get(fragmentId) as { linked_count: number } | undefined;
  const expectedLinkCount = rootFrag?.linked_count ?? 0;
  const actualLinkCount = linkedIds.length - 1;

  const channelCounts: Record<string, number> = {};
  for (const f of fragments) {
    channelCounts[f.channel] = (channelCounts[f.channel] || 0) + 1;
  }

  const eventSummary = fragments.map((f) => `[${f.channel}] ${f.summary}`).join("; ").slice(0, 200);

  return {
    fragments,
    eventSummary,
    fragmentCount: fragments.length,
    hasGaps: actualLinkCount < expectedLinkCount,
  };
}
