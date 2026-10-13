// 字图 (Character Graph) — spreading activation search accelerator
// Builds a character co-occurrence graph from fragment text (summary + keywords).
// On query, extracts seed characters, diffuses activation along edges,
// and returns top-N fragment IDs ranked by activation score.
//
// v5 experiment conclusion: 字图 is an accelerator (3351→50, 58% routing rate),
// NOT a replacement for semantic search. Used as the first route in three-route fusion.

import { getDb } from "../db/connection.js";

// ── Types ──────────────────────────────────────────────────────────────

interface GraphNode {
  char: string;
  fragmentIds: Set<string>;   // which fragments contain this char
  edges: Map<string, number>;  // neighbor char → co-occurrence count
}

interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  buildTimeMs: number;
}

// ── Graph state ────────────────────────────────────────────────────────

let graph: Map<string, GraphNode> | null = null;
let graphProjectId: string | null = null;
let graphProfileId: string | null = null;
let graphFragmentCount = 0; // detect staleness — rebuild when DB fragment count changes

function getCurrentProfileId(): string {
  return process.env.LINGXI_PROFILE_ID || "user_default";
}

// ── Build ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const cjkChars: string[] = [];
  // Chinese characters: keep both bigrams and single-char fallbacks.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/[一-鿿]/.test(ch)) {
      cjkChars.push(ch);
      tokens.push(ch);
    }
  }
  for (let i = 0; i < cjkChars.length - 1; i++) {
    tokens.push(cjkChars[i]! + cjkChars[i + 1]!);
  }
  // English tokens: alpha sequences length ≥ 2
  const alphaTokens = text.match(/[a-zA-Z0-9_]{2,}/g) || [];
  for (const tok of alphaTokens) {
    tokens.push(tok.toLowerCase());
  }
  return tokens;
}

function isAlphaToken(token: string): boolean {
  return /^[a-zA-Z0-9_]{2,}$/.test(token);
}

function isCjkBigram(token: string): boolean {
  return token.length === 2 && /[一-鿿]/.test(token[0]!) && /[一-鿿]/.test(token[1]!);
}

function isCjkChar(token: string): boolean {
  return token.length === 1 && /[一-鿿]/.test(token);
}

function isInformativeToken(token: string): boolean {
  return isAlphaToken(token) || isCjkBigram(token);
}

export function buildGraph(projectId: string): GraphStats {
  const startTime = Date.now();
  const db = getDb();
  const profileId = getCurrentProfileId();

  // Load fragment text (cap at 100 to prevent OOM with full-text fragments)
  const rows = db.prepare(`
    SELECT id, summary, keywords FROM fragments
    WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
      AND profile_id = ?
      AND id NOT LIKE 'reflect_%' AND session_id != 'reflection_cycle'
    ORDER BY created_at DESC LIMIT 80
  `).all(projectId, profileId) as Array<{ id: string; summary: string; keywords: string | null }>;

  const newGraph = new Map<string, GraphNode>();

  function getNode(char: string): GraphNode {
    let node = newGraph.get(char);
    if (!node) {
      node = { char, fragmentIds: new Set(), edges: new Map() };
      newGraph.set(char, node);
    }
    return node;
  }

  // Build graph from each fragment's text
  for (const row of rows) {
    // Combine summary + keywords for richer character co-occurrence
    const text = [row.summary, row.keywords].filter(Boolean).join(" ");
    const tokens = [...new Set(tokenize(text))]; // dedup per fragment

    if (tokens.length < 2) continue;

    // Add fragment to each token's node
    for (const tok of tokens) {
      getNode(tok).fragmentIds.add(row.id);
    }

    // Add co-occurrence edges
    for (let i = 0; i < tokens.length; i++) {
      const nodeA = getNode(tokens[i]!);
      for (let j = i + 1; j < tokens.length; j++) {
        const nodeB = getNode(tokens[j]!);
        nodeA.edges.set(tokens[j]!, (nodeA.edges.get(tokens[j]!) ?? 0) + 1);
        nodeB.edges.set(tokens[i]!, (nodeB.edges.get(tokens[i]!) ?? 0) + 1);
      }
    }
  }

  graph = newGraph;
  graphProjectId = projectId;
  graphProfileId = profileId;
  graphFragmentCount = rows.length;

  // V5: prune weak edges — cap each node's co-occurrence edges to keep the
  // in-memory graph small (25万 → ~7万 edges) without losing top recall.
  pruneEdges(MAX_EDGES_PER_NODE);

  const edgeCount = [...newGraph.values()].reduce((sum, n) => sum + n.edges.size, 0) / 2;
  return {
    nodeCount: newGraph.size,
    edgeCount: Math.floor(edgeCount),
    buildTimeMs: Date.now() - startTime,
  };
}

// 每节点最多保留的强共现边数（超过则裁剪，降低内存占用）
const MAX_EDGES_PER_NODE = 30;

function pruneEdges(limit: number): void {
  if (!graph) return;
  for (const node of graph.values()) {
    if (node.edges.size > limit) {
      const sorted = [...node.edges.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      node.edges = new Map(sorted);
    }
  }
}

// ── Stats ──────────────────────────────────────────────────────────────

export function getGraphStats(): GraphStats | null {
  if (!graph) return null;
  const edgeCount = [...graph.values()].reduce((sum, n) => sum + n.edges.size, 0) / 2;
  return {
    nodeCount: graph.size,
    edgeCount: Math.floor(edgeCount),
    buildTimeMs: 0, // not tracked after initial build
  };
}

// ── Search ──────────────────────────────────────────────────────────────

export interface CharGraphResult {
  fragmentId: string;
  score: number; // 0-1 activation score
}

export function search(
  query: string,
  projectId: string,
  topK: number = 50
): CharGraphResult[] {
  // Rebuild graph if project changed, graph not initialized, OR stale (new fragments added)
  if (!graph || graphProjectId !== projectId || isGraphStale(projectId)) {
    buildGraph(projectId);
  }

  if (!graph || graph.size === 0) return [];

  // Extract seed tokens from query
  const rawSeedTokens = [...new Set(tokenize(query))];
  const informativeSeeds = rawSeedTokens.filter(isInformativeToken);
  const seedTokens = informativeSeeds.length > 0 ? informativeSeeds : rawSeedTokens;
  if (seedTokens.length === 0) return [];

  // Direct-hit first, expansion second.
  const DECAY = 0.35;
  const HOP_LIMIT = 1;
  const totalFragments = Math.max(graphFragmentCount, 1);

  const getTokenWeight = (token: string): number => {
    const node = graph!.get(token);
    if (!node) return 0;
    const df = Math.max(node.fragmentIds.size, 1);
    const idf = Math.log(1 + totalFragments / df);
    if (isAlphaToken(token)) return idf * 1.6;
    if (isCjkBigram(token)) return idf * 1.35;
    return idf * 0.2;
  };

  const shouldSpread = (token: string, weight: number): boolean => {
    if (isCjkChar(token)) return false;
    return weight >= 0.35;
  };

  const trimActivation = (scores: Map<string, number>, limit: number): Map<string, number> => {
    if (scores.size <= limit) return scores;
    return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
  };

  const directScores = new Map<string, number>();
  const expansionScores = new Map<string, number>();
  const matchedSeedCounts = new Map<string, Set<string>>();

  const addMatchedSeed = (fragmentId: string, seed: string): number => {
    let matched = matchedSeedCounts.get(fragmentId);
    if (!matched) {
      matched = new Set<string>();
      matchedSeedCounts.set(fragmentId, matched);
    }
    matched.add(seed);
    return matched.size;
  };

  for (const seed of seedTokens) {
    const node = graph.get(seed);
    if (!node) continue;
    const seedWeight = getTokenWeight(seed);
    if (seedWeight <= 0) continue;
    for (const fragId of node.fragmentIds) {
      const matchedCount = addMatchedSeed(fragId, seed);
      const exactBonus = matchedCount > 1 ? 1 + (matchedCount - 1) * 0.12 : 1;
      directScores.set(fragId, (directScores.get(fragId) ?? 0) + seedWeight * exactBonus);
    }
  }

  let activation = new Map<string, number>();
  for (const seed of seedTokens) {
    const seedWeight = getTokenWeight(seed);
    if (shouldSpread(seed, seedWeight)) {
      activation.set(seed, seedWeight);
    }
  }

  for (let hop = 0; hop < HOP_LIMIT; hop++) {
    const nextActivation = new Map<string, number>();
    const decay = Math.pow(DECAY, hop);

    for (const [char, act] of activation) {
      const node = graph.get(char);
      if (!node) continue;
      const tokenWeight = getTokenWeight(char);
      if (!shouldSpread(char, tokenWeight)) continue;

      // Spread to neighbors for next hop
      for (const [neighbor, coocCount] of node.edges) {
        const neighborWeight = getTokenWeight(neighbor);
        if (neighborWeight < 0.2) continue;
        const spreadAct = act
          * decay
          * Math.min(coocCount / 8, 1.0)
          * (neighborWeight / Math.max(tokenWeight, 0.15))
          * 0.18;
        if (spreadAct < 0.02) continue;

        nextActivation.set(
          neighbor,
          (nextActivation.get(neighbor) ?? 0) + spreadAct
        );

        const neighborNode = graph.get(neighbor);
        if (!neighborNode) continue;
        for (const fragId of neighborNode.fragmentIds) {
          expansionScores.set(fragId, (expansionScores.get(fragId) ?? 0) + spreadAct);
        }
      }
    }

    activation = trimActivation(nextActivation, 24);
  }

  const allFragmentIds = new Set<string>([
    ...directScores.keys(),
    ...expansionScores.keys(),
  ]);
  if (allFragmentIds.size === 0) return [];

  const rawScores = new Map<string, number>();
  for (const fragmentId of allFragmentIds) {
    const direct = directScores.get(fragmentId) ?? 0;
    const expansion = expansionScores.get(fragmentId) ?? 0;
    const matchedCount = matchedSeedCounts.get(fragmentId)?.size ?? 0;
    const countBonus = matchedCount > 1 ? Math.min(0.45, (matchedCount - 1) * 0.16) : 0;
    rawScores.set(fragmentId, direct + expansion * 0.25 + countBonus);
  }

  // Normalize scores to 0-1 range
  const maxScore = Math.max(1, ...rawScores.values());

  // Sort and return top K
  const results: CharGraphResult[] = [];
  for (const [fragmentId, rawScore] of rawScores) {
    results.push({ fragmentId, score: rawScore / maxScore });
  }
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, topK);
}

// ── Incremental update ─────────────────────────────────────────────────

export function addToGraph(fragmentId: string, summary: string, keywords: string | null): void {
  if (!graph) return;

  const text = [summary, keywords].filter(Boolean).join(" ");
  const tokens = [...new Set(tokenize(text))];
  if (tokens.length < 2) return;

  function getOrCreate(char: string): GraphNode {
    let node = graph!.get(char);
    if (!node) {
      node = { char, fragmentIds: new Set(), edges: new Map() };
      graph!.set(char, node);
    }
    return node;
  }

  for (const tok of tokens) {
    getOrCreate(tok).fragmentIds.add(fragmentId);
  }

  for (let i = 0; i < tokens.length; i++) {
    const nodeA = getOrCreate(tokens[i]!);
    for (let j = i + 1; j < tokens.length; j++) {
      const nodeB = getOrCreate(tokens[j]!);
      nodeA.edges.set(tokens[j]!, (nodeA.edges.get(tokens[j]!) ?? 0) + 1);
      nodeB.edges.set(tokens[i]!, (nodeB.edges.get(tokens[i]!) ?? 0) + 1);
    }
  }

  graphFragmentCount++; // approximate — will be corrected on next staleness check
}

export function removeFromGraph(fragmentId: string): void {
  if (!graph) return;

  // Simple approach: rebuild on next search
  // For incremental removal, just invalidate
  graphFragmentCount++; // approximate — will be corrected on next staleness check
}

// ── Lifecycle ───────────────────────────────────────────────────────────

export function invalidateGraph(): void {
  graph = null;
  graphProjectId = null;
  graphProfileId = null;
}

export function isGraphReady(): boolean {
  return graph !== null && graph.size > 0;
}

// Check if graph needs rebuild (new fragments added since last build).
// Called before search to keep long-running processes in sync.
function isGraphStale(projectId: string): boolean {
  const profileId = getCurrentProfileId();
  if (!graph || graphProjectId !== projectId || graphProfileId !== profileId) return true;
  try {
    const db = getDb();
    const current = (db.prepare(
      "SELECT COUNT(*) as cnt FROM fragments WHERE project_id = ? AND profile_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'"
    ).get(projectId, profileId) as { cnt: number }).cnt;
    return current !== graphFragmentCount;
  } catch {
    return false; // DB not ready, keep existing graph
  }
}
