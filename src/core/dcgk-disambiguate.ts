// 灵络 Disambiguate — 语义消歧 & 动态节点聚类
// v2: cognitive_v5 embedding cosine similarity (primary) + bigram fallback
// 锚点 → 现有图节点相似度匹配 → 合并或新建

import { loadAllNodes, upsertNode, upsertEdge } from "./dcgk-store.js";
import { addMemoryNode, bootstrapEdges } from "./dcgk-engine.js";
import { search as charGraphSearch } from "./char-graph.js";
import { getDb } from "../db/connection.js";
import { encodeCognitiveBatch } from "./cognitive-state.js";

// ── Config ───────────────────────────────────────────

// Cosine thresholds (embedding mode)
const COSINE_MERGE = 0.70;    // cosine ≥ this → merge with existing node
const COSINE_CREATE = 0.60;   // cosine < this → create new node (high bar: only truly distinct concepts)
// Limbo (0.30, 0.70): ambiguous → discard

// Bigram thresholds (fallback mode)
const BIGRAM_MERGE = 0.15;
const BIGRAM_CREATE = 0.06;

// ── Embedding Client ─────────────────────────────────

async function embedBatch(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const vecs = await encodeCognitiveBatch(texts);
    if (vecs.length !== texts.length) return null;
    if (vecs.some((v) => !v || v.length === 0)) return null;
    return vecs as number[][];
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── Bigram Fallback ──────────────────────────────────

function extractBigrams(text: string): Set<string> {
  const bgs = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) {
    if (/[一-鿿]/.test(text[i]!) && /[一-鿿]/.test(text[i+1]!)) {
      bgs.add(text[i]! + text[i+1]!);
    }
  }
  for (const tok of text.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) || []) {
    if (tok.length >= 2) bgs.add(tok.toLowerCase());
  }
  return bgs;
}

function bigramSimilarity(anchor: string, nodeLabel: string): number {
  const aBgs = extractBigrams(anchor);
  const nBgs = extractBigrams(nodeLabel);
  if (aBgs.size === 0 || nBgs.size === 0) return 0;
  let intersection = 0;
  for (const bg of aBgs) { if (nBgs.has(bg)) intersection++; }
  const union = new Set([...aBgs, ...nBgs]).size;
  const jaccard = intersection / union;
  const aWords = new Set(anchor.toLowerCase().split(/[\s._\-]+/).filter(w => w.length >= 2));
  const nWords = new Set(nodeLabel.toLowerCase().split(/[\s._\-]+/).filter(w => w.length >= 2));
  let substringHits = 0;
  for (const aw of aWords) {
    for (const nw of nWords) {
      if (aw.includes(nw) || nw.includes(aw)) { substringHits++; break; }
    }
  }
  const substringBonus = Math.min(substringHits / Math.max(aWords.size, 1), 1.0) * 0.4;
  return Math.min(jaccard * 0.6 + substringBonus, 1.0);
}

// ── Cache ────────────────────────────────────────────

// Primary: node_id → embedding vector
let nodeEmbeddingCache: Map<string, number[]> | null = null;
// Fallback: node_id → bigram set
let nodeBigramCache: Map<string, Set<string>> | null = null;
// Track embedding mode availability
let useEmbedding = true;

async function refreshCache(): Promise<void> {
  const nodes = loadAllNodes();
  const labels = nodes.map(n => n.id + " " + n.label);

  // Try embedding first
  const embeddings = await embedBatch(labels);
  if (embeddings && embeddings.length === nodes.length) {
    nodeEmbeddingCache = new Map();
    for (let i = 0; i < nodes.length; i++) {
      nodeEmbeddingCache.set(nodes[i]!.id, embeddings[i]!);
    }
    useEmbedding = true;
    nodeBigramCache = null; // not needed
    return;
  }

  // Fallback: bigram
  useEmbedding = false;
  nodeBigramCache = new Map();
  for (const n of nodes) {
    nodeBigramCache.set(n.id, extractBigrams(n.id + " " + n.label));
  }
}

// ── Similarity Computation ───────────────────────────

async function computeSimilarity(anchor: string, nodeId: string): Promise<number> {
  const nodes = loadAllNodes();
  const node = nodes.find(n => n.id === nodeId);
  const nodeLabel = node ? nodeId + " " + node.label : nodeId;

  if (useEmbedding && nodeEmbeddingCache) {
    const cachedVec = nodeEmbeddingCache.get(nodeId);
    if (!cachedVec) return 0;
    // Embed anchor on-the-fly (single text via batch API)
    const anchorEmbeddings = await embedBatch([anchor]);
    if (!anchorEmbeddings || anchorEmbeddings.length === 0) {
      // Fallback for single anchor: use bigram
      return bigramSimilarity(anchor, nodeLabel);
    }
    return cosineSimilarity(anchorEmbeddings[0]!, cachedVec);
  }

  // Bigram fallback
  if (nodeBigramCache) {
    // Fast path: use cached bigrams
    const aBgs = extractBigrams(anchor);
    const nBgs = nodeBigramCache.get(nodeId);
    if (!nBgs || nBgs.size === 0) return 0;
    let intersection = 0;
    for (const bg of aBgs) { if (nBgs.has(bg)) intersection++; }
    return intersection / new Set([...aBgs, ...nBgs]).size;
  }

  return bigramSimilarity(anchor, nodeLabel);
}

// ── Resolution ───────────────────────────────────────

function fullLabelFor(nodeId: string): string {
  const nodes = loadAllNodes();
  const node = nodes.find(n => n.id === nodeId);
  return node ? nodeId + " " + node.label : nodeId;
}

export async function resolveAnchor(anchor: string): Promise<string | null> {
  // Safety: filter trivial anchors
  if (anchor.length < 2 || /^\d+$/.test(anchor)) return null;
  if (anchor.length === 1 && /[一-鿿]/.test(anchor)) return null;

  const needsRefresh =
    (useEmbedding && (!nodeEmbeddingCache || nodeEmbeddingCache.size === 0)) ||
    (!useEmbedding && (!nodeBigramCache || nodeBigramCache.size === 0));

  if (needsRefresh) {
    await refreshCache();
  }

  // Collect all existing node IDs
  const existingIds: string[] = [];
  if (useEmbedding && nodeEmbeddingCache) {
    for (const id of nodeEmbeddingCache.keys()) existingIds.push(id);
  } else if (nodeBigramCache) {
    for (const id of nodeBigramCache.keys()) existingIds.push(id);
  }

  // Find best match
  let bestScore = 0;
  let bestId = anchor;

  for (const nodeId of existingIds) {
    const score = await computeSimilarity(anchor, nodeId);
    if (score > bestScore) {
      bestScore = score;
      bestId = nodeId;
    }
  }

  const mergeThresh = useEmbedding ? COSINE_MERGE : BIGRAM_MERGE;
  const createThresh = useEmbedding ? COSINE_CREATE : BIGRAM_CREATE;

  // Decision
  if (bestScore >= mergeThresh) {
    return bestId; // merge
  }

  if (bestScore < createThresh) {
    // Novel concept
    if (anchor.length >= 3 || /^[A-Z]/.test(anchor)) {
      await createConceptNode(anchor);
      return anchor;
    }
    return null;
  }

  // Limbo: discard
  return null;
}

export async function resolveAnchors(rawAnchors: string[]): Promise<string[]> {
  const needsRefresh =
    (useEmbedding && (!nodeEmbeddingCache || nodeEmbeddingCache.size === 0)) ||
    (!useEmbedding && (!nodeBigramCache || nodeBigramCache.size === 0));

  if (needsRefresh) {
    await refreshCache();
  }

  // Batch-embed all anchors once (single API call)
  const validAnchors = rawAnchors.filter(a => a.length >= 2 && !/^\d+$/.test(a) && !(a.length === 1 && /[一-鿿]/.test(a)));
  if (validAnchors.length === 0) return [];

  if (useEmbedding && nodeEmbeddingCache) {
    const anchorEmbeddings = await embedBatch(validAnchors);
    if (anchorEmbeddings && anchorEmbeddings.length === validAnchors.length) {
      // Compute all cosine similarities in one pass
      const resolved = new Set<string>();
      for (let ai = 0; ai < validAnchors.length; ai++) {
        const anchor = validAnchors[ai]!;
        const anchorVec = anchorEmbeddings[ai]!;
        let bestScore = 0;
        let bestId = anchor;

        for (const [nodeId, nodeVec] of nodeEmbeddingCache) {
          const score = cosineSimilarity(anchorVec, nodeVec);
          if (score > bestScore) { bestScore = score; bestId = nodeId; }
        }

        if (bestScore >= COSINE_MERGE) {
          resolved.add(bestId);
        } else if (bestScore < COSINE_CREATE) {
          if (anchor.length >= 3 || /^[A-Z]/.test(anchor)) {
            await createConceptNode(anchor);
            resolved.add(anchor);
          }
        }
        // Limbo: discard
      }
      return [...resolved];
    }
  }

  // Fallback: resolve one by one
  const resolved = new Set<string>();
  for (const a of validAnchors) {
    const result = await resolveAnchor(a);
    if (result !== null) resolved.add(result);
  }
  return [...resolved];
}

// ── Dynamic Node Creation ────────────────────────────

async function createConceptNode(anchor: string): Promise<void> {
  upsertNode({
    id: anchor,
    label: anchor,
    activation: 0,
    confidence: 0.3,
    plasticity: 0.7,
    last_updated: Date.now(),
  });

  addMemoryNode(anchor, anchor);

  // Add embedding to cache if available
  if (useEmbedding) {
    const embeddings = await embedBatch([anchor]);
    if (embeddings && embeddings.length > 0) {
      if (!nodeEmbeddingCache) nodeEmbeddingCache = new Map();
      nodeEmbeddingCache.set(anchor, embeddings[0]!);
    }
  } else if (nodeBigramCache) {
    nodeBigramCache.set(anchor, extractBigrams(anchor));
  }

  // Bootstrap topology: use bootstrapEdges for both in-memory graph AND SQLite
  const result = bootstrapEdges(anchor, [], 0);
  console.log(`  [灵络] New concept node: "${anchor}"${result.created > 0 ? ` +${result.created} 初始边 → [${result.targetState || "emotion_nodes"}]` : ""}`);
}

// ── Diagnostics ──────────────────────────────────────

export function disambiguationStats(): { totalNodes: number; cacheSize: number; mode: string } {
  return {
    totalNodes: loadAllNodes().length,
    cacheSize: nodeEmbeddingCache?.size ?? nodeBigramCache?.size ?? 0,
    mode: useEmbedding ? "embedding(cognitive_v5)" : "bigram(fallback)",
  };
}

// ── Hybrid Disambiguation: 语义(cognitive_v5) + 符号(字图) ──
// 统一输出灵络 Node IDs，后续由灵络引擎统一推演

export interface HybridResult {
  nodeIds: string[];
  semanticHits: string[];
  symbolicHits: string[];
}

export async function hybridResolveAnchors(
  rawAnchors: string[],
  projectId: string = "C--Users-Administrator",
): Promise<HybridResult> {
  const semanticHits: string[] = [];
  const symbolicHits: string[] = [];

  // ═══════════════════════════════════════════
  // Path A: cognitive_v5 语义消歧 (高阈值 0.60)
  // ═══════════════════════════════════════════
  try {
    const resolved = await resolveAnchors(rawAnchors);
    semanticHits.push(...resolved);
  } catch (e: any) {
    console.log("  [灵络消歧] 语义路径异常: " + e.message);
  }

  // ═══════════════════════════════════════════
  // Path B: 字图符号映射
  // ═══════════════════════════════════════════
  try {
    // Char-graph search on the full user query to find related fragments
    const queryStr = rawAnchors.join(" ");
    const cgResults = charGraphSearch(queryStr, projectId, 20);
    if (cgResults.length > 0) {
      const db = getDb();
      const seenNode = new Set(semanticHits);
      for (const r of cgResults.slice(0, 15)) {
        try {
          const anchors = db.prepare(
            "SELECT label FROM fragment_anchors WHERE fragment_id = ?"
          ).all(r.fragmentId) as Array<{ label: string }>;
          for (const a of anchors) {
            if (!a.label || a.label.length < 2) continue;
            if (!seenNode.has(a.label)) {
              symbolicHits.push(a.label);
              seenNode.add(a.label);
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch (e: any) {
    console.log("  [灵络消歧] 符号路径异常: " + e.message);
  }

  // ═══════════════════════════════════════════
  // Fusion: Set_A ∪ Set_B
  // ═══════════════════════════════════════════
  const nodeIds = [...new Set([...semanticHits, ...symbolicHits])];

  console.log(
    "  [灵络消歧] 语义路径: [" + semanticHits.join(", ") + "]" +
    " | 符号路径(字图): [" + symbolicHits.slice(0, 5).join(", ") +
    (symbolicHits.length > 5 ? "..." : "") + "]" +
    " → 合并: " + nodeIds.length + " 节点"
  );

  return { nodeIds, semanticHits, symbolicHits };
}

// Force cache refresh (manual recovery hook)
export async function refreshNodeCache(): Promise<void> {
  await refreshCache();
}

// Reset function for clean test runs
export function resetDisambiguation(): void {
  nodeEmbeddingCache = null;
  nodeBigramCache = null;
  useEmbedding = true;
}
