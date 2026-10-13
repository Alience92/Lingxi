import type { Fragment, SearchResult, PrefetchResult, SessionContext } from "../types.js";
import { getDb } from "../db/connection.js";
import { getCurrentEmbedder, cosineSimilarity } from "./embedder.js";
import { search as charGraphSearch, isGraphReady, buildGraph, type CharGraphResult } from "./char-graph.js";
import { encodeCognitiveState, cognitiveSimilarity, isCognitiveReady } from "./cognitive-state.js";
import { envWithLegacy } from "../config.js";

const COGNITIVE_EMBED_DIM = 1024;

const API_MIN_SCORE = 0.30;
const HASH_MIN_SCORE = 0.12;
const DEFAULT_MAX_RESULTS = 6;

function getDefaultMinScore(): number {
  try {
    return getCurrentEmbedder().isSemanticUnavailable() ? HASH_MIN_SCORE : API_MIN_SCORE;
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

const PERF_TIMING = envWithLegacy("LINGXI_PERF_TIMING", "AGENTMEMORY_PERF_TIMING") === "1";

// ── P2: Silent associative prefetch with anchor weighting + cluster + MMR

export async function prefetch(
  messages: SessionContext["lastMessages"],
  projectId: string
): Promise<PrefetchResult> {
  const t0 = Date.now();
  if (messages.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  const rawQueryText = messages.slice(-3).map((m) => m.text).join("\n");
  const queryText = expandQueryForProject(rawQueryText, projectId);

  // Fast path: when semantic is off, use char-graph directly.
  // Character overlap alone achieves 99% Gold-in-Top300 recall for context injection.
  const useSemanticPrefetch = (() => {
    const semanticFlag = envWithLegacy("LINGXI_SEMANTIC", "AGENTMEMORY_SEMANTIC");
    if (semanticFlag === "0") return false;
    if (semanticFlag === "1") return true;
    try {
      // 语义层可用性 = cognitive_v5 本地 ONNX 模型是否存在（不再依赖 embedding URL）。
      return !getCurrentEmbedder().isSemanticUnavailable();
    } catch { return false; }
  })();

  if (!useSemanticPrefetch) {
    // ── Fast path: char-graph → score → MMR ────────────────
    if (!isGraphReady()) buildGraph(projectId);
    const cgResults = charGraphSearch(queryText, projectId, 300);
    if (cgResults.length === 0) {
      const db = getDb();
      const pendingCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ? AND pending_fragmentation > 0"
      ).get(projectId) as { cnt: number }).cnt;
      if (pendingCount > 0) {
        return { contextBlock: "[AgentMemory] 上一段对话还在消化中，大约需要半分钟。", fragmentIds: [], confidence: 0.1 };
      }
      return { contextBlock: "", fragmentIds: [], confidence: 0 };
    }

    const db = getDb();
    const candidateIds = cgResults.slice(0, 50).map(r => r.fragmentId);
    const cgScoreMap = new Map(cgResults.map(r => [r.fragmentId, r.score]));

    // Batch-load fragments
    const fragmentRows = new Map<string, Record<string, unknown>>();
    for (let offset = 0; offset < candidateIds.length; offset += 200) {
      const batch = candidateIds.slice(offset, offset + 200);
      const ph = batch.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT * FROM fragments WHERE id IN (${ph})
          AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
      `).all(...batch) as Array<Record<string, unknown>>;
      for (const row of rows) fragmentRows.set(row.id as string, row);
    }

    // Build in CG order, apply composite scoring
    const projectScope = `project:${projectId}`;
    interface PrefetchCandidate { fragment: Fragment; compositeScore: number; id: string }
    const candidates: PrefetchCandidate[] = [];
    for (const cg of cgResults) {
      const row = fragmentRows.get(cg.fragmentId);
      if (!row) continue;
      const f: Fragment = {
        id: row.id as string, sessionId: row.session_id as string, projectId: row.project_id as string,
        summary: row.summary as string, linkedCount: row.linked_count as number,
        decayScore: row.decay_score as number, lastRecalledAt: row.last_recalled_at as number | null,
        recalledCount: row.recalled_count as number, createdAt: row.created_at as number,
        retrievalState: (row.retrieval_state as "active"|"warm") ?? "warm",
        assetState: (row.asset_state as "retained") ?? "retained",
        distilledTo: row.distilled_to as string | undefined, scope: (row.scope as string) || null,
        anchors: [], linkedIds: [],
      };
      const maxAnchorWeight = Math.max(...((row.anchors as Array<{weight:number}>) || []).map(a => a.weight), 10) / 255;
      // Length-normalized CG score
      const fragLen = Math.max((row.summary as string).length + ((row.keywords as string)?.length ?? 0), 1);
      const normCg = cg.score / fragLen;
      let compositeScore = normCg * 0.5 + maxAnchorWeight * 0.3 + f.decayScore * 0.2;
      if (!f.scope || f.scope === projectScope) compositeScore += 0.05;
      candidates.push({ fragment: f, compositeScore, id: f.id });
    }
    // Normalize and sort
    const maxNorm = Math.max(...candidates.map(c => c.compositeScore), 0.001);
    for (const c of candidates) c.compositeScore /= maxNorm;
    candidates.sort((a, b) => b.compositeScore - a.compositeScore);

    // MMR diversity (no embedding cache in fast path — skip MMR, use linked-id dedup)
    const selected: PrefetchCandidate[] = [];
    const usedIds = new Set<string>();
    for (const c of candidates) {
      if (usedIds.has(c.id)) continue;
      if (selected.length >= 5) break;
      selected.push(c);
      usedIds.add(c.id);
    }

    // Build context block
    const fragmentIds: string[] = [];
    let block = "";
    for (const s of selected) {
      const channel = "WHAT";
      const scoreTag = `[相关度: ${s.compositeScore.toFixed(2)}] `;
      const candidate = `${scoreTag}[${channel}] ${s.fragment.summary}`;
      if (block.length + candidate.length + 2 <= PREFETCH_BUDGET_CHARS) {
        block = block ? `${block}\n${candidate}` : candidate;
        fragmentIds.push(s.fragment.id);
      }
    }

    // Conflict detection
    if (selected.length >= 2) {
      let conflicts = detectConflicts(selected.map(s => s.fragment));
      if (conflicts.length > CONFLICT_HIGH_DENSITY_CUTOFF) {
        conflicts = detectConflicts(selected.map(s => s.fragment), { sharedBigrams: 6, divergeEntities: 3 });
      }
      if (conflicts.length > 0) block += formatConflictBlock(conflicts);
    }

    // Activation log
    try {
      const qHash = String(queryText.length * 31 + queryText.charCodeAt(0));
      const now = Date.now();
      const log = db.prepare(`INSERT INTO activation_log (fragment_id, query_hash, activated_at) VALUES (?, ?, ?)`);
      for (const id of fragmentIds) log.run(id, qHash, now);
    } catch {}

    return { contextBlock: block, fragmentIds, confidence: selected.length > 0 ? Math.min(0.9, selected[0]?.compositeScore ?? 0) : 0 };
  }

  // ── Full path: cognitive_v5 embedding + vector search (existing) ───────
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
    const scoreTag = r.score > 0 ? `[相关度: ${r.score.toFixed(2)}] ` : "";
    const candidate = `${scoreTag}${signal}[${channel}] ${r.fragment.summary}`;
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

  // Conflict detection: flag potentially contradictory memories
  if (selected.length >= 2) {
    let conflicts = detectConflicts(selected.map(r => r.fragment));
    // High-density pool: auto-tighten thresholds to suppress noise
    if (conflicts.length > CONFLICT_HIGH_DENSITY_CUTOFF) {
      conflicts = detectConflicts(selected.map(r => r.fragment), { sharedBigrams: 6, divergeEntities: 3 });
    }
    if (conflicts.length > 0) {
      block += formatConflictBlock(conflicts);
    }
  }

  return { contextBlock: block, fragmentIds, confidence };
}

// ── Dynamic route weighting ─────────────────────────────────────────
// v5 experiment conclusion (June 9, 2026):
//   Char-graph excels at temporal, negation, comparison — bge-m3 is blind here.
//   Semantic (bge-m3) excels at open-domain, single-hop factual queries.
//   Aggressive routing (dominant route 0.6-0.7, weak route 0.1) beats
//   balanced RRF by preventing noise from the wrong route diluting signal.
//
//   Production pool benchmark: char-graph top-300 recall 99.0%.
//   Adversarial +13.3pp, Open-domain +12.5pp with aggressive weights.

interface RouteWeights {
  charGraph: number;
  keyword: number;
  semantic: number;
}

function computeWeights(query: string): RouteWeights {
  const len = query.length;
  const alphaCount = (query.match(/[a-zA-Z0-9_]{2,}/g) || []).length;
  const cjkCount = (query.match(/[一-鿿]/g) || []).length;

  // Temporal: 字图 owns this dimension. bge-m3 can't distinguish time words.
  // Phase 0 proved 54.3% temporal accuracy via char-graph alone (vs 28.6% cosine).
  const hasTemporal = /时间|日期|顺序|先后|之前|之后|以前|以后|最近|上周|下周|昨天|明天|今天|年|月|日|时候|何时|多久|几点|星期|周几/.test(query);

  // Negation / comparison: char-graph character overlap catches exact wording.
  // bge-m3 maps negations to similar vectors as affirmatives — actively harmful.
  const hasNegation = /不|没有|并非|错误|不对|不是|否|无|未|非|别|莫|禁止|拒绝|例外|除了/.test(query);
  const hasComparison = /比较|相比|区别|不同|差异|哪个更|最|更|比|优于|不如/.test(query);

  // Multi-hop: balanced — needs char-graph entity bridge + semantic concept linking
  const hasMultiHop = /为什么|怎么|原因|关系|关联|导致|影响|后果|间接|通过|经由|依赖/.test(query);

  if (hasTemporal) {
    // 字图 dominant (0.7): time-word co-occurrence patterns are the signal.
    // Semantic at 0.1: intentionally suppressed — bge-m3 confuses time vectors.
    return { charGraph: 0.70, keyword: 0.20, semantic: 0.10 };
  }
  if (hasNegation || hasComparison) {
    // 字图 dominant (0.6): character-level matching catches exact negation wording.
    // Semantic at 0.1: prevents bge-m3 from drowning negation signal.
    return { charGraph: 0.60, keyword: 0.30, semantic: 0.10 };
  }
  if (alphaCount >= 2 && cjkCount < 4) {
    // English/code heavy: FTS5 keyword dominant
    return { charGraph: 0.20, keyword: 0.50, semantic: 0.30 };
  }
  if (hasMultiHop) {
    // Multi-hop: balanced char-graph + semantic for connecting concepts
    return { charGraph: 0.40, keyword: 0.20, semantic: 0.40 };
  }
  if (len <= 8 && cjkCount >= 3) {
    // Short CJK keyword: char-graph edge
    return { charGraph: 0.50, keyword: 0.25, semantic: 0.25 };
  }
  // Default: semantic dominant for open-domain / single-hop
  // (these are bge-m3's strong suit — 72-85% accuracy in benchmarks)
  return { charGraph: 0.20, keyword: 0.20, semantic: 0.60 };
}

// ── Cognitive state bias ─────────────────────────────────────────────
// System-state signals (recency, frequency, FEEL weight) bias retrieval
// without needing a trained model. Based on cognitive internalization
// experiment (cos 0.967): system-state is learnable and stable.

interface CognitiveBias {
  recencyBoost: number;   // boost recently-recalled fragments
  frequencyBoost: number; // boost frequently-recalled fragments
  feelBoost: number;      // boost high-FEEL-weight fragments
}

// ── Conflict Detection ────────────────────────────────────────────────
// Activated when two fragments share ≥4 CJK bigrams (context) but
// diverge on ≥2 entities/numbers — potential memory conflict.
// Benchmark: +4.0pp LLM accuracy (June 10, 2026, 150 questions).

interface ConflictPair {
  fragA: string;  // first 120 chars of fragment A
  fragB: string;  // first 120 chars of fragment B
  divergence: string[];
}

// Thresholds validated experimentally (+4pp LLM accuracy, June 10 2026, 150 questions).
// Kept fixed for normal density; high-density pools trigger auto-tightening at call site.
const CONFLICT_SHARED_BIGRAMS = 4;
const CONFLICT_DIVERGE_ENTITIES = 2;
const CONFLICT_HIGH_DENSITY_CUTOFF = 5; // if >5 conflict pairs, pool is too dense

function detectConflicts(
  fragments: Array<{ id: string; summary: string; keywords?: string | null }>,
  thresholds?: { sharedBigrams?: number; divergeEntities?: number }
): ConflictPair[] {
  const sharedThreshold = thresholds?.sharedBigrams ?? CONFLICT_SHARED_BIGRAMS;
  const divergeThreshold = thresholds?.divergeEntities ?? CONFLICT_DIVERGE_ENTITIES;
  const conflicts: ConflictPair[] = [];
  const MAX_CONFLICTS = 2;

  for (let i = 0; i < fragments.length && conflicts.length < MAX_CONFLICTS; i++) {
    for (let j = i + 1; j < fragments.length && conflicts.length < MAX_CONFLICTS; j++) {
      const ta = (fragments[i]!.summary || "") + " " + (fragments[i]!.keywords || "");
      const tb = (fragments[j]!.summary || "") + " " + (fragments[j]!.keywords || "");

      // Shared CJK bigrams
      const bigrams = (t: string): Set<string> => {
        const bg = new Set<string>();
        for (let k = 0; k < t.length - 1; k++) {
          if (/[一-鿿]/.test(t[k]!) && /[一-鿿]/.test(t[k+1]!)) {
            bg.add(t[k]! + t[k+1]!);
          }
        }
        return bg;
      };
      const ba = bigrams(ta);
      const bb = bigrams(tb);
      const shared = new Set([...ba].filter(x => bb.has(x)));

      // Diverging entities/numbers
      const entities = (t: string): Set<string> => {
        const ents = t.match(/[A-Z][a-z]+|[A-Z]{2,}|\d+\.?\d*|"[^"]+"/g) || [];
        return new Set(ents.map(e => e.toLowerCase()));
      };
      const ea = entities(ta);
      const eb = entities(tb);
      const diverge = new Set([...ea].filter(x => !eb.has(x)).concat([...eb].filter(x => !ea.has(x))));

      if (shared.size >= sharedThreshold && diverge.size >= divergeThreshold) {
        conflicts.push({
          fragA: ta.slice(0, 120),
          fragB: tb.slice(0, 120),
          divergence: [...diverge].slice(0, 5),
        });
      }
    }
  }
  return conflicts;
}

function formatConflictBlock(conflicts: ConflictPair[]): string {
  if (conflicts.length === 0) return "";
  let block = "\n\n--- 以下记忆可能存在矛盾，请对比后选择最可信的答案 ---";
  for (const c of conflicts) {
    block += `\n  记忆A: ${c.fragA}`;
    block += `\n  记忆B: ${c.fragB}`;
    block += `\n  分歧点: ${c.divergence.join(", ")}\n`;
  }
  return block;
}

// ── Cognitive state bias ─────────────────────────────────────────────

function getCognitiveBias(projectId: string): CognitiveBias {
  const db = getDb();

  // Check recent frustration/correction signals → boost FEEL fragments
  const recentFeel = db.prepare(`
    SELECT COUNT(*) as cnt FROM lightweight_signals
    WHERE project_id = ? AND signal_type IN ('correction','frustration')
      AND created_at > ?
  `).get(projectId, Date.now() - 30 * 60 * 1000) as { cnt: number };

  // If user has been correcting recently, boost preference/rule fragments
  const feelBoost = recentFeel.cnt > 0 ? 0.15 : 0.05;

  return {
    recencyBoost: 0.10,    // always boost recent
    frequencyBoost: 0.05,  // always boost frequent
    feelBoost,             // dynamic based on recent signals
  };
}

// Apply cognitive bias to fragment scores
function applyCognitiveBias(
  fragmentId: string,
  baseScore: number,
  bias: CognitiveBias,
  fragmentMeta: Map<string, { recalledCount: number; lastRecalledAt: number | null; feelWeight: number }>
): number {
  const meta = fragmentMeta.get(fragmentId);
  if (!meta) return baseScore;

  let boosted = baseScore;

  // Recency: boost fragments recalled in the last hour
  if (meta.lastRecalledAt && meta.lastRecalledAt > Date.now() - 3600 * 1000) {
    boosted += bias.recencyBoost;
  }

  // Frequency: boost fragments recalled 5+ times
  if (meta.recalledCount >= 5) {
    boosted += bias.frequencyBoost;
  }

  // FEEL: boost fragments with high FEEL anchor weight (important signals)
  if (meta.feelWeight >= 50) {
    boosted += bias.feelBoost;
  }

  return boosted;
}

// ── Activation Cache (Working Memory) ──────────────────────────────
// Maintains "currently active" fragments across queries.
// Retrieved fragments stay warm; decay over time; boundary neighbors
// get pre-activated. Next query biases toward still-active fragments.
//
// This is Opus recommendation A+E: activation persistence + graph position.

interface ActivatedFragment {
  fragmentId: string;
  activation: number;      // 0-1, exponential decay
  lastActivated: number;   // timestamp ms
  source: 'retrieved' | 'expanded';
}

const activationCache = new Map<string, ActivatedFragment>();
const DECAY_RATE = 0.0005;   // per-second: 1min→97%, 5min→86%, 30min→41%
const MAX_CACHE_SIZE = 50;
const BOOST_WEIGHT = 0.15;   // max score boost from activation

/** Call after each explicitSearch to maintain working memory. */
export function touchActivation(fragmentIds: string[]): void {
  const now = Date.now();
  // Decay all
  for (const [fid, af] of activationCache) {
    const elapsed = (now - af.lastActivated) / 1000;
    af.activation *= Math.exp(-DECAY_RATE * elapsed);
    af.lastActivated = now;
    if (af.activation < 0.01) activationCache.delete(fid);
  }
  // Add / boost retrieved
  for (const fid of fragmentIds.slice(0, 10)) {
    const existing = activationCache.get(fid);
    if (existing) {
      existing.activation = Math.min(existing.activation + 0.25, 1.0);
      existing.lastActivated = now;
    } else {
      activationCache.set(fid, { fragmentId: fid, activation: 0.25, lastActivated: now, source: 'retrieved' });
    }
  }
  // Boundary expansion: activate strongest neighbors of top-3
  const top3 = [...activationCache.entries()]
    .filter(([,af]) => af.source === 'retrieved')
    .sort((a,b) => b[1].activation - a[1].activation)
    .slice(0, 3);
  const db = getDb();
  for (const [fid] of top3) {
    const links = db.prepare(`SELECT target_id FROM fragment_links WHERE source_id = ? LIMIT 5`).all(fid) as Array<{ target_id: string }>;
    for (const { target_id } of links) {
      if (!activationCache.has(target_id)) {
        activationCache.set(target_id, { fragmentId: target_id, activation: 0.12, lastActivated: now, source: 'expanded' });
      }
    }
  }
  // Prune
  if (activationCache.size > MAX_CACHE_SIZE) {
    const sorted = [...activationCache.entries()].sort((a,b) => b[1].activation - a[1].activation);
    for (const [fid] of sorted.slice(MAX_CACHE_SIZE)) activationCache.delete(fid);
  }
}

/** Boost for fragments still in working memory. 0 = not active, BOOST_WEIGHT = fully active. */
export function getActivationBoost(fragmentId: string): number {
  const af = activationCache.get(fragmentId);
  return af ? af.activation * BOOST_WEIGHT : 0;
}

/** Top-N currently active fragments — can be injected into LLM context as "recent context". */
export function getActiveContext(topN: number = 10): Array<{ fragmentId: string; activation: number }> {
  return [...activationCache.entries()]
    .sort((a, b) => b[1].activation - a[1].activation)
    .slice(0, topN)
    .map(([fid, af]) => ({ fragmentId: fid, activation: af.activation }));
}

/** Reset working memory (new session, topic switch). */
export function resetActivation(): void {
  activationCache.clear();
}

// ── Multi-hop expansion ──────────────────────────────────────────────
// For queries with multi-hop indicators, expand results by following
// fragment_links to find connected fragments.

function expandMultiHop(
  results: SearchResult[],
  projectId: string,
  maxExpand: number = 3
): SearchResult[] {
  if (results.length === 0) return results;

  const db = getDb();
  const existingIds = new Set(results.map(r => r.fragment.id));
  const expanded: SearchResult[] = [...results];

  for (const result of results.slice(0, 3)) {
    if (expanded.length >= results.length + maxExpand) break;

    // Find linked fragments
    const links = db.prepare(`
      SELECT f.* FROM fragments f
      JOIN fragment_links l ON l.target_id = f.id
      WHERE l.source_id = ? AND f.retrieval_state IN ('active','warm')
        AND f.asset_state != 'user_deleted'
        AND f.id NOT IN (${[...existingIds].map(() => '?').join(',')})
      LIMIT 1
    `).all(result.fragment.id, ...existingIds) as Array<Record<string, unknown>>;

    for (const row of links) {
      const id = row.id as string;
      if (existingIds.has(id)) continue;
      existingIds.add(id);

      const f: Fragment = {
        id,
        sessionId: row.session_id as string,
        projectId: row.project_id as string,
        summary: row.summary as string,
        linkedCount: row.linked_count as number,
        decayScore: row.decay_score as number,
        lastRecalledAt: row.last_recalled_at as number | null,
        recalledCount: row.recalled_count as number,
        createdAt: row.created_at as number,
        retrievalState: (row.retrieval_state as "active" | "warm") ?? "warm",
        assetState: (row.asset_state as "retained") ?? "retained",
        distilledTo: row.distilled_to as string | undefined,
        scope: (row.scope as string) || null,
        anchors: [],
        linkedIds: [],
      };

      expanded.push({
        fragment: f,
        score: result.score * 0.7, // slightly lower score for linked fragments
        matchedAnchors: [],
        missingLinks: 0,
      });
    }
  }

  return expanded;
}

// P3: Explicit search — three-route fusion (字图 + FTS5 + cognitive_v5)
// Fast mode: pure char-graph top-300 (99% recall).
// Skips semantic embedding (~300ms) and RRF fusion. Char-graph activation
// scores directly rank results. For query types where char-graph dominates
// (temporal, negation, short CJK), this path is faster AND more accurate.
export async function explicitSearch(
  query: string,
  projectId: string,
  minScore?: number,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<SearchResult[]> {
  minScore = minScore ?? getDefaultMinScore();
  const expandedQuery = expandQueryForProject(query, projectId);
  const weights = computeWeights(expandedQuery);
  // 语义层可用性 = cognitive_v5 本地 ONNX 模型是否存在。
  // LINGXI_SEMANTIC=0 强制关闭，=1 强制开启。
  const useSemantic = (() => {
    const semanticFlag = envWithLegacy("LINGXI_SEMANTIC", "AGENTMEMORY_SEMANTIC");
    if (semanticFlag === "0") return false;
    if (semanticFlag === "1") return true;
    try {
      return !getCurrentEmbedder().isSemanticUnavailable();
    } catch { return false; }
  })();

  // Ensure 字图 is built
  if (!isGraphReady()) {
    const stats = buildGraph(projectId);
    if (PERF_TIMING) {
      console.error(`[AgentMemory] 字图建成: ${stats.nodeCount}节点 ${stats.edgeCount}边 ${stats.buildTimeMs}ms`);
    }
  }

  // ── Fast path: pure char-graph, no embedding ─────────────────
  // Collects ALL candidates from CG order, then scores, sorts, and slices.
  // SQL IN returns rows in arbitrary order — must NOT break early on DB order.
  if (!useSemantic) {
    const cgResults = charGraphSearch(expandedQuery, projectId, 300);
    if (cgResults.length === 0) return [];

    const db = getDb();
    // Load all CG top-300 (not truncated by maxResults) to preserve full recall pool
    const candidateIds = cgResults.slice(0, 300).map(r => r.fragmentId);
    const cgScoreMap = new Map(cgResults.map(r => [r.fragmentId, r.score]));

    // Batch-load ALL fragments into a map — no early break on DB order
    const fragmentRows = new Map<string, Record<string, unknown>>();
    for (let offset = 0; offset < candidateIds.length; offset += 200) {
      const batch = candidateIds.slice(offset, offset + 200);
      const ph = batch.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT * FROM fragments WHERE id IN (${ph})
          AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
      `).all(...batch) as Array<Record<string, unknown>>;
      for (const row of rows) {
        fragmentRows.set(row.id as string, row);
      }
    }

    // Build results in cgResults ORDER (preserves char-graph ranking)
    const results: SearchResult[] = [];
    for (const cg of cgResults) {
      const row = fragmentRows.get(cg.fragmentId);
      if (!row) continue;

      const f: Fragment = {
        id: row.id as string,
        sessionId: row.session_id as string,
        projectId: row.project_id as string,
        summary: row.summary as string,
        linkedCount: row.linked_count as number,
        decayScore: row.decay_score as number,
        lastRecalledAt: row.last_recalled_at as number | null,
        recalledCount: row.recalled_count as number,
        createdAt: row.created_at as number,
        retrievalState: (row.retrieval_state as "active" | "warm") ?? "warm",
        assetState: (row.asset_state as "retained") ?? "retained",
        distilledTo: row.distilled_to as string | undefined,
        scope: (row.scope as string) || null,
        anchors: [],
        linkedIds: [],
      };

      // Cap text length to prevent ultra-long summaries from dominating CG scores.
      // LLM-generated summaries are capped at 180 chars in the fragmenter; memory-file
      // imports can produce 500+ char summaries that distort length normalization.
      const fragTextLen = Math.min(
        Math.max((row.summary as string).length + ((row.keywords as string)?.length ?? 0), 1),
        200
      );
      const meta = { rawCgScore: cg.score, fragTextLen, hasRecency: f.lastRecalledAt != null && f.lastRecalledAt > Date.now() - 3600_000, highFreq: f.recalledCount >= 5 };

      results.push({ fragment: f, score: cg.score, matchedAnchors: [], missingLinks: 0 });
      (results[results.length - 1] as any).__meta = meta;
    }

    // Compute normalized CG scores using P95 as reference.
    // CG activation favors longer fragments; length normalization corrects this.
    // P95 avoids the max-norm problem where one fragment is always 1.0.
    const normCgs = results.map(r => {
      const m = (r as any).__meta;
      return m ? m.rawCgScore / m.fragTextLen : 0;
    }).sort((a, b) => a - b);
    const p95NormCg = normCgs[Math.floor(normCgs.length * 0.95)] || 0.001;

    for (const r of results) {
      const m = (r as any).__meta;
      if (m) {
        let score = (m.rawCgScore / m.fragTextLen) / p95NormCg;
        if (score > 1.0) score = 1.0 + (score - 1.0) * 0.1; // soft cap above 1.0
        if (m.hasRecency) score += 0.02;
        if (m.highFreq) score += 0.01;
        r.score = score;
        delete (r as any).__meta;
      }
    }

    // ── Keyword boost: match query terms against fragment keywords ──
    // Keywords field stores human-labeled discriminating terms ("字图,衰减,冲突")
    // — much sparser than summary bigrams. Matching here adds specificity
    // that CG alone can't provide, without needing bge-m3.
    if (weights.keyword > 0) {
      // Extract discriminating terms from query: CJK bigrams + alpha tokens
      const qBigrams: string[] = [];
      for (let i = 0; i < expandedQuery.length - 1; i++) {
        if (/[一-鿿]/.test(expandedQuery[i]!) && /[一-鿿]/.test(expandedQuery[i+1]!)) {
          qBigrams.push(expandedQuery[i]! + expandedQuery[i+1]!);
        }
      }
      const alphaTokens = expandedQuery.match(/[a-zA-Z0-9_]{2,}/g) || [];
      const allTerms = [...new Set([...qBigrams, ...alphaTokens])];

      if (allTerms.length > 0) {
        // Count keyword hits per fragment against already-loaded rows
        for (const r of results) {
          const row = fragmentRows.get(r.fragment.id);
          const kw = ((row?.keywords as string) || "").toLowerCase();
          if (!kw) continue;
          let hits = 0;
          for (const term of allTerms) {
            if (kw.includes(term.toLowerCase())) hits++;
          }
          if (hits > 0) {
            const kwScore = hits / allTerms.length;
            r.score = r.score * 0.7 + kwScore * 0.3;
          }
        }
      }
    }

    // ── Activation boost: fragments still in working memory ──
    for (const r of results) {
      const boost = getActivationBoost(r.fragment.id);
      if (boost > 0) r.score += boost;
    }

    results.sort((a, b) => b.score - a.score);
    const trimmed = results.slice(0, maxResults);

    // Update recall timestamps + activation cache
    touchActivation(trimmed.map(r => r.fragment.id));
    for (const r of trimmed) {
      db.prepare(`UPDATE fragments SET decay_score = 1.0, last_recalled_at = ? WHERE id = ?`).run(Date.now(), r.fragment.id);
    }

    return trimmed;
  }

  // ── Full path: three-route fusion ────────────────────────────
  // Route 1: 字图 — get top-300 (experiment 19: 99% Gold-in-Top300)
  let charGraphMap = new Map<string, number>();
  if (weights.charGraph > 0) {
    const cgResults = charGraphSearch(expandedQuery, projectId, 300);
    for (const r of cgResults) {
      charGraphMap.set(r.fragmentId, r.score);
    }
  }

  // Route 2: cognitive_v5 semantic — existing pipeline
  const queryVec = await getCurrentEmbedder().embed(expandedQuery, "query");
  const { results: semanticResults, cache } = await vectorSearch(
    queryVec, projectId, Math.max(maxResults * 3, 30), minScore * 0.5,
    { recallMode: "explicit", query: expandedQuery }
  );

  // Route 3: FTS5 BM25 keyword — independent rank (was sharing semantic rank before fix)
  const db = getDb();
  const kwRank = new Map<string, number>();
  if (weights.keyword > 0) {
    try {
      // Use FTS5 BM25 scoring on summary + keywords fields
      const kwRows = db.prepare(`
        SELECT f.id, bm25(fragments_fts, 1.0, 0.75) as bm25_score
        FROM fragments_fts fts
        JOIN fragments f ON f.id = fts.rowid
        WHERE fragments_fts MATCH ?
          AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted'
        ORDER BY bm25_score
        LIMIT 100
      `).all(expandedQuery.replace(/[一-鿿]/g, ' "$&" ')) as Array<{ id: string; bm25_score: number }>;
      // BM25 scores are negative (lower=better), invert to rank
      const maxBm25 = Math.max(...kwRows.map(r => r.bm25_score), -0.001);
      kwRows.forEach((r, i) => {
        kwRank.set(r.id, i + 1);
      });
    } catch {
      // FTS5 match may fail on special chars — fall through, keyword route stays silent
    }
  }

  // Score each fragment with three-route weighted fusion
  const allFragmentIds = new Set<string>();
  for (const sr of semanticResults) allFragmentIds.add(sr.fragment.id);
  for (const id of charGraphMap.keys()) allFragmentIds.add(id);
  for (const id of kwRank.keys()) allFragmentIds.add(id);

  // Build fused results
  const fused: Array<{ fragmentId: string; score: number }> = [];
  const K = 60; // RRF constant

  // Build rank maps from each route
  const semRank = new Map<string, number>();
  semanticResults.forEach((sr, i) => semRank.set(sr.fragment.id, i + 1));

  const cgSorted = [...charGraphMap.entries()].sort((a, b) => b[1] - a[1]);
  const cgRank = new Map<string, number>();
  cgSorted.forEach(([id], i) => cgRank.set(id, i + 1));

  const maxSemRank = semanticResults.length + 1;
  const maxCgRank = cgSorted.length + 1;
  const maxKwRank = kwRank.size + 1;

  for (const fragmentId of allFragmentIds) {
    const sRank = semRank.get(fragmentId) ?? maxSemRank;
    const cRank = cgRank.get(fragmentId) ?? maxCgRank;
    const kRank = kwRank.get(fragmentId) ?? maxKwRank;

    // Weighted RRF: three independent rank sources
    const semScore = weights.semantic / (K + sRank);
    const cgScore = weights.charGraph / (K + cRank);
    const kwScore = weights.keyword / (K + kRank);

    let baseScore = semScore + cgScore + kwScore;
    // Activation boost: fragments still in working memory
    baseScore += getActivationBoost(fragmentId);

    fused.push({
      fragmentId,
      score: baseScore,
    });
  }

  fused.sort((a, b) => b.score - a.score);

  // Convert to SearchResult, loading fragments as needed
  const results: SearchResult[] = [];
  const hitIds = new Set<string>();
  const fragmentMap = new Map<string, Fragment>();

  // Load fragments from semantic results (or from DB in fast mode)
  for (const sr of semanticResults) {
    fragmentMap.set(sr.fragment.id, sr.fragment);
  }

  // Load any char-graph fragments not in semantic results
  const missingIds = [...new Set(
    fused.map(f => f.fragmentId).filter(id => !fragmentMap.has(id))
  )].slice(0, 20);

  if (missingIds.length > 0) {
    const batchSize = 200;
    for (let offset = 0; offset < missingIds.length; offset += batchSize) {
      const batch = missingIds.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT * FROM fragments WHERE id IN (${placeholders})
          AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
      `).all(...batch) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const f: Fragment = {
          id: r.id as string,
          sessionId: r.session_id as string,
          projectId: r.project_id as string,
          summary: r.summary as string,
          linkedCount: r.linked_count as number,
          decayScore: r.decay_score as number,
          lastRecalledAt: r.last_recalled_at as number | null,
          recalledCount: r.recalled_count as number,
          createdAt: r.created_at as number,
          retrievalState: (r.retrieval_state as "active" | "warm") ?? "warm",
          assetState: (r.asset_state as "retained") ?? "retained",
          distilledTo: r.distilled_to as string | undefined,
          scope: (r.scope as string) || null,
          anchors: [],
          linkedIds: [],
        };
        fragmentMap.set(f.id, f);
      }
    }
  }

  for (const { fragmentId, score } of fused) {
    const fragment = fragmentMap.get(fragmentId);
    if (!fragment) continue;
    if (score < minScore * 0.1) continue; // very low threshold for fusion

    hitIds.add(fragment.id);
    results.push({
      fragment,
      score,
      matchedAnchors: fragment.linkedIds,
      missingLinks: 0,
    });

    // Bump recall timestamp (but NOT recalled_count — only increment on active use)
    db.prepare(`UPDATE fragments SET decay_score = 1.0, last_recalled_at = ? WHERE id = ?`).run(
      Date.now(), fragment.id
    );

    if (results.length >= maxResults) break;
  }

  // ── Cognitive state bias ──────────────────────────────────────────
  // Try model-based cognitive state inference first; fall back to heuristics.
  // Cognitive state vector (1024d) 与 fragments.vector 中 vector_model='cognitive_v5'
  // 的向量同空间，cosine 直接度量认知相关性。
  const cognitiveVec = await encodeCognitiveState(expandedQuery);

  if (cognitiveVec && results.length > 0) {
    // Model-based: compute cognitive similarity for each result fragment
    // Load cognitive_v5 fragment vectors for cognitive similarity
    const resultIds = results.map(r => r.fragment.id);
    const cogMeta = new Map<string, { vec: number[] }>();
    for (let offset = 0; offset < resultIds.length; offset += 200) {
      const batch = resultIds.slice(offset, offset + 200);
      const ph = batch.map(() => "?").join(",");
      const vecRows = db.prepare(`
        SELECT id, vector FROM fragments
        WHERE id IN (${ph}) AND vector IS NOT NULL AND vector_model = 'cognitive_v5'
      `).all(...batch) as Array<{ id: string; vector: Buffer | null }>;
      for (const vr of vecRows) {
        if (vr.vector && vr.vector.length >= COGNITIVE_EMBED_DIM * 4) {
          const vec = new Array<number>(COGNITIVE_EMBED_DIM);
          for (let i = 0; i < COGNITIVE_EMBED_DIM; i++) {
            vec[i] = vr.vector.readFloatLE(i * 4);
          }
          // L2 normalize
          const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
          if (norm > 1e-8) {
            for (let i = 0; i < COGNITIVE_EMBED_DIM; i++) vec[i]! /= norm;
          }
          cogMeta.set(vr.id, { vec });
        }
      }
    }

    if (cogMeta.size > 0) {
      const COG_WEIGHT = 0.25; // cognitive signal weight in final score
      for (const r of results) {
        const meta = cogMeta.get(r.fragment.id);
        if (meta) {
          const cogScore = cognitiveSimilarity(cognitiveVec, meta.vec);
          // Blend: 75% RRF score + 25% cognitive similarity
          r.score = (1 - COG_WEIGHT) * r.score + COG_WEIGHT * cogScore;
        }
      }
      results.sort((a, b) => b.score - a.score);
      if (PERF_TIMING) {
        console.error(`[AgentMemory] Cognitive bias applied to ${cogMeta.size} fragments, weight=${COG_WEIGHT}`);
      }
    }
  } else {
    // Fallback: heuristic cognitive bias (recency, frequency, FEEL)
    const bias = getCognitiveBias(projectId);
    const fragmentMeta = new Map<string, { recalledCount: number; lastRecalledAt: number | null; feelWeight: number }>();

    if (results.length > 0) {
      const resultIds = results.map(r => r.fragment.id);
      for (let offset = 0; offset < resultIds.length; offset += 200) {
        const batch = resultIds.slice(offset, offset + 200);
        const ph = batch.map(() => "?").join(",");
        const metaRows = db.prepare(`
          SELECT f.id, f.recalled_count, f.last_recalled_at,
                 COALESCE((SELECT MAX(fa.weight) FROM fragment_anchors fa
                  WHERE fa.fragment_id = f.id AND fa.channel = 'FEEL'), 0) as feel_weight
          FROM fragments f WHERE f.id IN (${ph})
        `).all(...batch) as Array<{ id: string; recalled_count: number; last_recalled_at: number | null; feel_weight: number }>;
        for (const mr of metaRows) {
          fragmentMeta.set(mr.id, { recalledCount: mr.recalled_count, lastRecalledAt: mr.last_recalled_at, feelWeight: mr.feel_weight });
        }
      }

      for (const r of results) {
        r.score = applyCognitiveBias(r.fragment.id, r.score, bias, fragmentMeta);
      }
      results.sort((a, b) => b.score - a.score);
    }
  }

  // ── Multi-hop expansion ───────────────────────────────────────────
  const hasMultiHop = /为什么|怎么|原因|关系|关联|导致|影响|后果/.test(expandedQuery);
  let finalResults = results;
  if (hasMultiHop && results.length > 0) {
    finalResults = expandMultiHop(results, projectId, 3);
  }

  // Maintain activation cache (working memory across queries)
  touchActivation(finalResults.slice(0, maxResults).map(r => r.fragment.id));

  // Record query event
  if (expandedQuery) {
    db.prepare(`INSERT INTO query_events (id, project_id, query, result_count, source, searched_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      `qe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      projectId, expandedQuery, finalResults.length, "explicit", Date.now()
    );
  }

  return finalResults.slice(0, maxResults);
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
  // Extract CJK bigrams + alphanumeric tokens as search terms (scoped for reuse in RRF)
  const cleaned = originalQuery ? originalQuery.replace(/[，。！？、；：""''（）\s]+/g, "") : "";
  const alphaTokens = [...new Set((originalQuery || "").match(/[a-zA-Z0-9_]{2,}/g) || [])];
  const cjkBigrams: string[] = [];
  const seenCjk = new Set<string>();
  if (originalQuery) {
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
        const likeClauses = uniqueTerms.map(() => "(summary LIKE ? OR keywords LIKE ?)").join(" OR ");
        const likeParams = uniqueTerms.flatMap(t => [`%${t}%`, `%${t}%`]);
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

  // ── Two-route fusion: semantic (bge-m3) + keyword (bigram/token match) ──
  // Dynamic weights based on query length: short → keyword-heavy, long → semantic-heavy
  const isShortQuery = originalQuery.length < 8;
  const isLongQuery = originalQuery.length > 20;
  const kwWeight = isShortQuery ? 0.65 : isLongQuery ? 0.35 : 0.5;
  const semWeight = 1.0 - kwWeight;

  // Build keyword match set from query for fast lookup
  const queryTerms = new Set<string>();
  if (originalQuery) {
    for (const bg of cjkBigrams) queryTerms.add(bg);
    for (const tok of alphaTokens) queryTerms.add(tok.toLowerCase());
  }

  for (const fragment of rows) {
    const fragVec = cache.get(fragment.id)!;
    const cosineScore = cosineSimilarity(queryVec, fragVec);

    // Keyword match density: fraction of query terms found in fragment summary
    let kwScore = 0;
    if (queryTerms.size > 0 && fragment.summary) {
      const summary = fragment.summary;
      let matched = 0;
      for (const term of queryTerms) {
        if (summary.includes(term)) matched++;
      }
      kwScore = matched / queryTerms.size;
    }

    // RRF-inspired fusion: combine semantic and keyword scores
    const fusedScore = semWeight * cosineScore + kwWeight * kwScore;
    const effectiveMinScore = minScore * (1.0 - kwWeight * 0.5); // lower threshold for keyword-heavy queries

    if (fusedScore >= effectiveMinScore) {
      hitIds.add(fragment.id);
      results.push({
        fragment,
        score: fusedScore,
        matchedAnchors: fragment.linkedIds,
        missingLinks: 0,
      });

      if (recallMode === "explicit" && originalQuery) {
        db.prepare(`INSERT INTO recall_log (fragment_id, query, score, recalled_at) VALUES (?, ?, ?, ?)`).run(
          fragment.id, originalQuery, fusedScore, Date.now()
        );
      }
      // Update decay and timestamp (recalled_count managed by recall_log)
      db.prepare(`UPDATE fragments SET decay_score = 1.0, last_recalled_at = ? WHERE id = ?`).run(
        Date.now(), fragment.id
      );
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
