import type { Fragment, SearchResult, PrefetchResult, SessionContext } from "../types.js";
import { getDb } from "../db/connection.js";
import { embed, cosineSimilarity } from "./embedder.js";

const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_MAX_RESULTS = 6;
const PREFETCH_CHAR_BUDGET = 150;

// P2: Silent associative prefetch
export async function prefetch(
  messages: SessionContext["lastMessages"],
  projectId: string
): Promise<PrefetchResult> {
  if (messages.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  const queryText = messages.slice(-3).map((m) => m.text).join("\n");
  const queryVec = await embed(queryText);
  const results = await vectorSearch(queryVec, projectId, 10, DEFAULT_MIN_SCORE);

  if (results.length === 0) return { contextBlock: "", fragmentIds: [], confidence: 0 };

  const topN = results.slice(0, 3);
  let block = "";
  const usedIds: string[] = [];
  for (const r of topN) {
    const anchor = r.fragment.anchors[0];
    const channel = anchor ? anchor.channel : "WHAT";
    const candidate = `${channel}: ${r.fragment.summary}`;
    if (block.length + candidate.length + 2 <= PREFETCH_CHAR_BUDGET) {
      block = block ? `${block}; ${candidate}` : candidate;
      usedIds.push(r.fragment.id);
    }
  }

  const confidence = topN.length > 0 ? Math.min(0.9, topN[0]?.score ?? 0) : 0;
  return { contextBlock: block, fragmentIds: usedIds, confidence };
}

// P3: Explicit search
export async function explicitSearch(
  query: string,
  projectId: string,
  minScore: number = DEFAULT_MIN_SCORE,
  maxResults: number = DEFAULT_MAX_RESULTS
): Promise<SearchResult[]> {
  const queryVec = await embed(query);
  return await vectorSearch(queryVec, projectId, maxResults, minScore);
}

async function vectorSearch(
  queryVec: number[],
  projectId: string,
  limit: number,
  minScore: number
): Promise<SearchResult[]> {
  const db = getDb();

  const rows = db.prepare(`
    SELECT * FROM fragments
    WHERE project_id = ? AND status = 'active' AND decay_score > 0
  `).all(projectId) as Fragment[];

  const results: SearchResult[] = [];

  for (const fragment of rows) {
    const fragVec = await embed(fragment.summary);
    const score = cosineSimilarity(queryVec, fragVec);

    if (score >= minScore) {
      const linkedRows = db.prepare(`
        SELECT target_id FROM fragment_links WHERE source_id = ?
      `).all(fragment.id) as Array<{ target_id: string }>;

      const matchedIds = [fragment.id, ...linkedRows.map((r) => r.target_id)];
      const uniqueMatched = [...new Set(matchedIds)];

      results.push({
        fragment,
        score,
        matchedAnchors: uniqueMatched,
        missingLinks: fragment.linkedCount - uniqueMatched.length + 1,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
