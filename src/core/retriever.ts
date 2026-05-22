import type { Fragment, SearchResult, PrefetchResult, SessionContext } from "../types.js";
import { getDb } from "../db/connection.js";
import { embed, cosineSimilarity } from "./embedder.js";

const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_MAX_RESULTS = 6;
// ~150 tokens ≈ 450 chars for CJK, 600 for English
const PREFETCH_BUDGET_CHARS = 450;

// P2: Silent associative prefetch with anchor weighting + cluster + MMR
export async function prefetch(
  messages: SessionContext["lastMessages"],
  projectId: string
): Promise<PrefetchResult> {
  if (messages.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  const queryText = messages.slice(-3).map((m) => m.text).join("\n");
  const queryVec = await embed(queryText);

  // Get more candidates for reranking
  const candidates = await vectorSearch(queryVec, projectId, 20, DEFAULT_MIN_SCORE * 0.6);

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

    // MMR penalty: higher similarity to selected fragments should reduce score.
    let mmrPenalty = 0;
    for (const sel of selected) {
      const sim = cosineSimilarity(
        await embed(candidate.fragment.summary),
        await embed(sel.fragment.summary)
      );
      mmrPenalty = Math.max(mmrPenalty, sim * 0.3);
    }
    const mmrScore = candidate.compositeScore - mmrPenalty;
    if (mmrScore < DEFAULT_MIN_SCORE * 0.5 && selected.length > 0) continue;

    selected.push(candidate);
    usedIds.add(candidate.fragment.id);
    // Also pull linked fragments into the cluster
    for (const linkedId of candidate.fragment.linkedIds) {
      usedIds.add(linkedId);
    }
  }

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
  return { contextBlock: block, fragmentIds, confidence };
}

// P3: Explicit search
export async function explicitSearch(
  query: string,
  projectId: string,
  minScore: number = DEFAULT_MIN_SCORE,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<SearchResult[]> {
  const queryVec = await embed(query);
  return await vectorSearch(queryVec, projectId, maxResults, minScore, {
    recallMode: "explicit",
    query,
  });
}

interface SearchOptions {
  recallMode?: "prefetch" | "explicit";
  query?: string;
}

async function vectorSearch(
  queryVec: number[],
  projectId: string,
  limit: number,
  minScore: number,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const db = getDb();
  const recallMode = options.recallMode ?? "prefetch";
  const originalQuery = options.query ?? "";

  const rows = db.prepare(`
    SELECT * FROM fragments
    WHERE project_id = ? AND status = 'active' AND decay_score > 0
  `).all(projectId) as Fragment[];

  const results: SearchResult[] = [];
  const hitIds = new Set<string>();
  const hitLinkedIds = new Map<string, string[]>(); // fragmentId → its linkedIds

  for (const fragment of rows) {
    const fragVec = await embed(fragment.summary);
    const score = cosineSimilarity(queryVec, fragVec);

    if (score >= minScore) {
      const linkedRows = db.prepare(`
        SELECT target_id FROM fragment_links WHERE source_id = ?
      `).all(fragment.id) as Array<{ target_id: string }>;

      const linkedIds = linkedRows.map((r) => r.target_id);
      hitIds.add(fragment.id);
      hitLinkedIds.set(fragment.id, linkedIds);

      results.push({
        fragment,
        score,
        matchedAnchors: [fragment.id, ...linkedIds],
        missingLinks: 0, // Filled in next pass
      });

      // Log recall events only for explicit user-triggered search.
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

  // Compute real missingLinks: how many linkedIds are NOT in the hit set
  for (const result of results) {
    const linkedIds = hitLinkedIds.get(result.fragment.id) ?? [];
    const missedLinks = linkedIds.filter((lid) => !hitIds.has(lid));
    result.missingLinks = missedLinks.length;
    result.matchedAnchors = linkedIds.filter((lid) => hitIds.has(lid));
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
