// memory-recall.ts — 灵络认知图召回（统一入口 + 加权融合排序）
// v4: 四路召回 — DCKG语义 + Char-Graph字面 + 向量相似度 + V5 FTS5
// 消歧 → 灵络内部(hybridResolveAnchors)
// 排序 → 基于 语义 activation + char-graph fragment score 加权融合

import { hybridResolveAnchors } from "./dcgk-disambiguate.js";
import { propagate, collectActivatedNodes, switchProfile } from "./dcgk-engine.js";
import { mapToDeltaSignal } from "./dcgk-signal.js";
import { search as charGraphSearch } from "./char-graph.js";
import { cognitiveVectorSearch } from "./cognitive-state.js";
import { explicitSearch } from "./retriever.js";
import { getDb } from "../db/connection.js";
import type { SearchResult } from "../types.js";
import { recordRecall } from "./state-gate.js";
import { searchUserModels } from "./v7-long-term-memory.js";

export interface RecallResult {
  content: string;
  score: number;
  source: "user_model" | "lingluo_fused_bge_priority" | "lingluo_fused_char_only" | "lingluo_fused_both" | "vector_search" | "v5_retriever";
  matchedNodes?: string[];
}

interface FragmentScore {
  content: string;
  fragmentId: string;
  fragmentKey: string;
  bgeScore: number;       // 0-1 semantic activation
  charScore: number;       // 0-1 from char-graph (normalized)
  lexicalScore: number;    // 0-1 from explicit lexical retrieval
  isBgeHit: boolean;
  isCharHit: boolean;
  subtype?: "decision" | "todo" | "preference" | null;
  source: RecallResult["source"];
}

function getIntentSubtypeBonus(query: string, subtype: FragmentScore["subtype"]): number {
  if (!subtype) return 0;
  if (subtype === "preference" && /(偏好|沟通|口吻|风格|回答|不喜欢|喜欢|避免|希望|想要|希望什么样|怎么.*说|怎么.*答|怎么.*沟通|如何.*沟通|如何.*回答|语气|措辞|表达|反馈|回复)/.test(query)) {
    return 0.12;
  }
  if (subtype === "decision" && /(默认|确认|不要直接|能不能直接|规则|操作|推送|允许|拒绝|可以|不可以|应该|不应该|必须|一定|提交|批准|通过|禁止|规定|约定|协议)/.test(query)) {
    return 0.10;
  }
  if (subtype === "todo" && /(最关键|目标|产出|最优先|基线|评测|待办|截止|原则|下一步|接下来|首先|先做|要做|打算|计划)/.test(query)) {
    return 0.10;
  }
  return 0;
}

function getQueryContentIntentBonus(query: string, content: string): number {
  const rules: Array<{ query: RegExp; content: RegExp; bonus: number }> = [
    { query: /(审查|review|findings)/, content: /(审查|review|findings|bug|风险|回归|缺失测试)/, bonus: 0.08 },
    { query: /(状态|state|统一入口)/, content: /(state-gate|统一入口|状态收敛|维护周期)/, bonus: 0.06 },
    { query: /(鼓励|安慰|空话|加油|你可以)/, content: /(鼓励|安慰|加油|信息量|空泛|可执行)/, bonus: 0.10 },
    { query: /(前端|移动端|桌面|终端)/, content: /(前端|移动端|桌面|加载|尺寸)/, bonus: 0.08 },
    { query: /(沟通|口吻|风格|简洁|直接|结论|技术化|表达|语气|措辞|回复.*方式|说话.*方式|怎么.*说)/, content: /(沟通|口吻|风格|简洁|直接|技术化|结论|共情|温和|陪伴|表达|语气|措辞)/, bonus: 0.10 },
    { query: /(写代码|代码.*注重|类型系统|TypeScript|JavaScript|类型)/, content: /(TypeScript|JavaScript|严格模式|宽松模式|类型标注|any|原型)/, bonus: 0.12 },
    { query: /(评测|基线|产出|最优先|原则|目标|准则)/, content: /(评测|基线|产出|最重要|目标|可重复|可统计|可回归|准则|原则)/, bonus: 0.08 },
    { query: /(吃饭|吃.*什么|餐厅|食堂|日料|火锅|居酒屋|村上|滨寿司|鸟重|推荐.*吃|想.*吃|饮食|菜系)/, content: /(吃|餐厅|食堂|日料|火锅|居酒屋|村上|滨寿司|鸟重|美食|料理|口味|饮食|菜系|吧台)/, bonus: 0.10 },
    { query: /(推送|提交|推送.*代码|提交.*代码|push|commit|上传)/, content: /(推送|提交|代码|仓库|push|commit|上传|允许|默认)/, bonus: 0.10 },
    { query: /(怎么.*做|如何.*做|流程|步骤|方案|做法|方法)/, content: /(做法|流程|步骤|方案|方法|怎么做|如何)/, bonus: 0.06 },
  ];

  let bonus = 0;
  for (const rule of rules) {
    if (rule.query.test(query) && rule.content.test(content)) {
      bonus += rule.bonus;
    }
  }
  return Math.min(bonus, 0.24);
}

function getQueryContentMismatchPenalty(query: string, content: string): number {
  if (/(写代码|代码.*注重|类型系统|TypeScript|JavaScript|类型)/.test(query) && !/(审查|评审|review)/i.test(query) && /(代码审查|审查优先级|安全漏洞|用户体验|CI 自动扫描)/.test(content)) {
    return 0.5;
  }
  if (/(饮食|菜系|吃.*什么|喜欢吃)/.test(query) && /(沟通|口吻|技术沟通|回答|表达|语气)/.test(content)) {
    return 0.08;
  }
  return 0;
}

function getCurrentProjectId(): string {
  return process.env.LINGXI_PROJECT_ID || "C--Users-Administrator";
}

function getCurrentProfileId(): string {
  return process.env.LINGXI_PROFILE_ID || "user_default";
}

function isFragmentInScope(fragmentId: string, projectId: string, profileId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM fragments WHERE id = ? AND project_id = ? AND profile_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'"
  ).get(fragmentId, projectId, profileId);
  return Boolean(row);
}

// ═══════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════

export async function recallFromCognitiveGraph(
  userInput: string,
  limit: number = 5,
): Promise<RecallResult[]> {
  // Step 1: 信号提取
  const signal = mapToDeltaSignal("neutral", "new_fact", userInput);
  const rawAnchors = signal.anchors.slice(0, 5);
  // Fallback: for short queries, use the raw words as anchors
  if (rawAnchors.length === 0 && userInput.length <= 10) {
    rawAnchors.push(userInput.trim());
  }
  if (rawAnchors.length === 0) return fallbackToV5(userInput, limit);

  const projectId = getCurrentProjectId();
  const profileId = getCurrentProfileId();
  switchProfile(profileId);
  const userModelResults = searchUserModels(userInput, projectId, profileId, Math.min(3, limit));
  const userModelTexts = new Set(userModelResults.map((model) => model.text));

  // ═══════════════════════════════════════════
  // Step 2: 双路召回并行
  // ═══════════════════════════════════════════

  // Path A: 灵络混合消歧 → node IDs + activation
  const hybrid = await hybridResolveAnchors(rawAnchors, projectId);
  let bgeActivationMap = new Map<string, number>(); // nodeId → activation
  if (hybrid.nodeIds.length > 0) {
    propagate(hybrid.nodeIds, 0);
    const activated = collectActivatedNodes(0.3);
    for (const n of activated) {
      bgeActivationMap.set(n.id, n.activation);
    }
  }

  // Path B: Char-Graph → fragmentId → score (normalized 0-1)
  let charFragmentMap = new Map<string, number>(); // fragmentKey → charScore
  let cgTopGap = 1;
  const queryStr = rawAnchors.join(" ");
  try {
    const cgResults = charGraphSearch(queryStr, projectId, 20);
    if (cgResults.length > 0) {
      cgTopGap = cgResults.length > 1 ? cgResults[0]!.score - cgResults[1]!.score : 1;
      // Normalize char-graph scores to 0-1 if needed
      const maxCg = Math.max(...cgResults.map(r => r.score), 1);
      for (const r of cgResults) {
        const normScore = r.score / maxCg;
        charFragmentMap.set(r.fragmentId, normScore);
      }
    }
  } catch { /* char-graph failure non-fatal */ }

  // Path C: cognitive 向量检索（cognitive_v5 句向量 → 碎片余弦，替代 bge-m3，全本地）
  // 兜底 DCGK evidence 边未覆盖的 query。无需概念节点 → 直接命中碎片。
  let vectorResults: Array<{ fragmentId: string; summary: string; score: number }> | null = null;
  try {
    const vResults = await cognitiveVectorSearch(userInput, 20, projectId);
    if (vResults.length > 0) {
      vectorResults = vResults;
      console.log(`  [灵络] 认知向量检索: ${vResults.length} hits (top=${vResults[0]!.score.toFixed(3)})`);
    }
  } catch { /* cognitive search failure non-fatal */ }

  // Path D: 显式检索只作为 rerank 信号，不替代主召回。
  const lexicalScoreMap = new Map<string, number>();
  const shouldUseLexicalRerank = userInput.length <= 4
    || /(偏好|沟通|口吻|风格|回答|不喜欢|喜欢|避免|希望什么样|默认|确认|不要直接|操作|推送|最关键|目标|产出|最优先|基线|评测|截止|原则|审查|代码|前端)/.test(userInput)
    || cgTopGap < 0.12;
  if (shouldUseLexicalRerank) {
    try {
      const lexicalResults = await explicitSearch(userInput, projectId, undefined, 15);
      const scopedLexicalResults = lexicalResults.filter((result) => isFragmentInScope(result.fragment.id, projectId, profileId));
      if (scopedLexicalResults.length > 0) {
        const maxLex = Math.max(...scopedLexicalResults.map((result) => result.score), 1);
        for (const result of scopedLexicalResults) {
          lexicalScoreMap.set(result.fragment.id, result.score / maxLex);
        }
      }
    } catch { /* lexical rerank failure non-fatal */ }
  }

  if (hybrid.nodeIds.length === 0 && charFragmentMap.size === 0 && !vectorResults?.length && userModelResults.length === 0) {
    console.log("  [灵络] 三路均无命中 → V5降级");
    return fallbackToV5(userInput, limit);
  }

  // ═══════════════════════════════════════════
  // Step 3: 碎片映射 + 分数跟踪
  // ═══════════════════════════════════════════

  const db = getDb();
  const scoreMap = new Map<string, FragmentScore>(); // fragmentKey → score

  // 3a. NEW: Trait node direct fragment lookup (灵络语义召回)
  // Search DCGK for trait nodes matching query keywords (bypass bge-m3 when it can't match)
  const queryWords = rawAnchors.join(" ").toLowerCase();
  const traitMatches = db.prepare(
    `SELECT id, confidence FROM dcgk_nodes WHERE id LIKE 'trait:%' AND label LIKE '%'||?||'%' LIMIT 10`
  ).all(queryWords) as Array<{ id: string; confidence: number }>;
  const traitNodeIds = traitMatches.map(r => r.id);

  if (traitNodeIds.length > 0) {
    try {
      const placeholders = traitNodeIds.map(() => "?").join(",");
      const evRows = db.prepare(
        `SELECT source_id, target_id, weight FROM dcgk_edges WHERE source_id IN (${placeholders}) AND etype='evidence' AND (lif_gen IS NULL OR lif_gen=0) ORDER BY weight DESC LIMIT 30`
      ).all(...traitNodeIds) as Array<{ source_id: string; target_id: string; weight: number }>;

      for (const ev of evRows) {
        const frag = db.prepare("SELECT id, summary, subtype FROM fragments WHERE id = ?").get(ev.target_id) as { id: string; summary: string; subtype?: "decision" | "todo" | "preference" | null } | undefined;
        if (!frag) continue;
        const key = frag.id;
        const existing = scoreMap.get(key);
        scoreMap.set(key, {
          content: frag.summary,
          fragmentId: frag.id,
          fragmentKey: key,
          bgeScore: ev.weight,  // evidence weight as relevance score
          charScore: existing?.charScore ?? 0,
          lexicalScore: Math.max(existing?.lexicalScore ?? 0, lexicalScoreMap.get(key) ?? 0),
          isBgeHit: true,
          isCharHit: existing?.isCharHit ?? false,
          subtype: existing?.subtype ?? frag.subtype ?? null,
          source: existing?.isCharHit ? "lingluo_fused_both" : "lingluo_fused_bge_priority",
        });
      }
      if (evRows.length > 0) console.log(`  [灵络] trait直接命中: ${evRows.length} fragments via ${traitNodeIds.length} trait nodes`);
    } catch (e: any) { console.log("  [灵络] trait lookup error: " + e.message); }
  }

  // 3b. From bge-m3 propagation: look up fragments via activated nodes (existing path)
  const nodePool = bgeActivationMap.size >= 2
    ? [...bgeActivationMap.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])
    : hybrid.nodeIds.slice(0, 10);

  for (const nodeId of nodePool) {
    const nodeActivation = bgeActivationMap.get(nodeId) ?? 0.5;
    try {
      const contentList = await searchFragmentsForNode(nodeId, 3);
      for (const hit of contentList) {
        const key = hit.fragmentId;
        const existing = scoreMap.get(key);
        const bgeScore = Math.max(existing?.bgeScore ?? 0, nodeActivation);
        const charScore = existing?.charScore ?? 0;
        scoreMap.set(key, {
          content: hit.content,
          fragmentId: hit.fragmentId,
          fragmentKey: key,
          bgeScore,
          charScore,
          lexicalScore: Math.max(existing?.lexicalScore ?? 0, lexicalScoreMap.get(key) ?? 0),
          isBgeHit: true,
          isCharHit: existing?.isCharHit ?? false,
          subtype: existing?.subtype ?? null,
          source: existing?.isCharHit ? "lingluo_fused_both" : "lingluo_fused_bge_priority",
        });
      }
    } catch { /* skip */ }
  }

  // 3b. From char-graph path: look up fragment content by fragmentId
  for (const [fragmentId, charScore] of charFragmentMap) {
    try {
      const row = db.prepare("SELECT id, summary, subtype FROM fragments WHERE id = ?").get(fragmentId) as { id: string; summary: string; subtype?: "decision" | "todo" | "preference" | null } | undefined;
      if (!row) continue;
      const content = row.summary;
      const key = row.id;
      const existing = scoreMap.get(key);
      const bgeScore = existing?.bgeScore ?? 0;
      scoreMap.set(key, {
        content,
        fragmentId: row.id,
        fragmentKey: key,
        bgeScore,
        charScore: Math.max(existing?.charScore ?? 0, charScore),
        lexicalScore: Math.max(existing?.lexicalScore ?? 0, lexicalScoreMap.get(key) ?? 0),
        isBgeHit: existing?.isBgeHit ?? false,
        isCharHit: true,
        subtype: existing?.subtype ?? row.subtype ?? null,
        source: existing?.isBgeHit ? "lingluo_fused_both" : "lingluo_fused_char_only",
      });
    } catch { /* skip */ }
  }

  // ═══════════════════════════════════════════
    // 3c. Vector search path: add scored fragments to scoreMap using fragmentId as key
  if (vectorResults) {
    for (const vr of vectorResults) {
      const key = vr.fragmentId; // stable key, not truncated summary
      const existing = scoreMap.get(key);
      const bgeScore = existing?.bgeScore ?? 0;
      const charScore = existing?.charScore ?? 0;
      scoreMap.set(key, {
        content: vr.summary, // full summary, not 50-char truncation
        fragmentId: vr.fragmentId,
        fragmentKey: vr.fragmentId,
        bgeScore: Math.max(bgeScore, vr.score * 0.6),
        charScore,
        lexicalScore: Math.max(existing?.lexicalScore ?? 0, lexicalScoreMap.get(key) ?? 0),
        isBgeHit: true,
        isCharHit: existing?.isCharHit ?? false,
        subtype: existing?.subtype ?? null,
        source: existing?.isCharHit ? "lingluo_fused_both" : existing?.isBgeHit ? "lingluo_fused_bge_priority" : "vector_search",
      });
    }
  }

  for (const [fragmentId, lexicalScore] of lexicalScoreMap) {
    const existing = scoreMap.get(fragmentId);
    if (!existing) continue;
    existing.lexicalScore = Math.max(existing.lexicalScore, lexicalScore);
  }

// Step 4: 加权融合排序
  // ═══════════════════════════════════════════

  const results: Array<{ content: string; finalScore: number; source: RecallResult["source"]; debug: string; fragmentId?: string }> = [];

  for (const model of userModelResults) {
    results.push({
      content: model.text,
      finalScore: model.score + 0.15,
      source: "user_model",
      debug: `model=${model.dimension} confidence=${model.confidence.toFixed(2)} evidence=${model.evidenceCount} → final=${(model.score + 0.15).toFixed(3)} ${model.text.slice(0, 40)}`,
    });
  }

  // V7-C: Load recency data for time-weighted scoring
  // Use fragmentKey (fragmentId) for lookup — must match 3c key
  const fragIdsForRecency = [...new Set([...scoreMap.values()].map(fs => fs.fragmentKey).filter(Boolean))];
  const recencyMap = new Map<string, number>();
  if (fragIdsForRecency.length > 0) {
    try {
      const placeholders = fragIdsForRecency.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id, last_recalled_at, recalled_count, created_at FROM fragments WHERE id IN (${placeholders}) LIMIT 100`
      ).all(...fragIdsForRecency) as Array<{ id: string; last_recalled_at: number | null; recalled_count: number; created_at: number }>;
      const now = Date.now();
      for (const r of rows) {
        const lastAccess = r.last_recalled_at || r.created_at;
        const ageHours = (now - lastAccess) / 3600000;
        const recencyFactor = Math.max(0.5, Math.exp(-ageHours / (24 * 30)));
        recencyMap.set(r.id, recencyFactor); // key = fragment id
      }
    } catch { /* non-fatal */ }
  }

  for (const fs of scoreMap.values()) {
    if (userModelTexts.has(fs.content.trim())) continue;
    // Dynamic lexical weight: boost for preference/rule/todo queries
    const isPreferenceQuery = /(偏好|沟通|口吻|风格|回答|不喜欢|喜欢|避免|希望|想要|怎么.*说|如何.*沟通|语气|措辞|表达|反馈|回复)/.test(userInput);
    const isRuleQuery = /(默认|确认|不要直接|能不能直接|规则|操作|推送|允许|拒绝|可以|不可以|应该|不应该|必须|提交|批准|禁止|规定)/.test(userInput);
    const isTodoQuery = /(最关键|目标|产出|最优先|基线|评测|待办|截止|原则|下一步|接下来|首先|先做|要做|打算|计划)/.test(userInput);
    const lexBoost = (isPreferenceQuery || isRuleQuery || isTodoQuery) ? 1.5 : 1.0;

    let finalScore: number;
    if (fs.isBgeHit && fs.isCharHit) {
      finalScore = fs.bgeScore * 0.58 + fs.charScore * 0.22 + fs.lexicalScore * 0.20 * lexBoost;
    } else if (fs.isBgeHit) {
      finalScore = fs.bgeScore * 0.60 + fs.lexicalScore * 0.22 * lexBoost;
    } else {
      finalScore = fs.charScore * 0.65 + fs.lexicalScore * 0.30 * lexBoost;
    }

    // V7-C: Apply time decay
    const timeFactor = recencyMap.get(fs.fragmentKey) ?? 1.0;
    finalScore *= timeFactor;
    finalScore += getIntentSubtypeBonus(userInput, fs.subtype);
    finalScore += getQueryContentIntentBonus(userInput, fs.content);
    finalScore -= getQueryContentMismatchPenalty(userInput, fs.content);

    const debug = [
      "bge=" + fs.bgeScore.toFixed(3),
      "char=" + fs.charScore.toFixed(3),
      "lex=" + fs.lexicalScore.toFixed(3),
      fs.subtype ? "subtype=" + fs.subtype : "subtype=-",
      "→ final=" + finalScore.toFixed(3),
      "[" + fs.source + "]",
      fs.content.slice(0, 40),
    ].join(" ");

    results.push({
      content: fs.content,
      finalScore,
      source: fs.source,
      debug,
      fragmentId: fs.fragmentId,
    });
  }

  // Deterministic sort: finalScore descending, then content length descending
  results.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return b.content.length - a.content.length;
  });

  // Log
  console.log("  [Fusion Score] " + results.length + " candidates:");
  for (let i = 0; i < Math.min(results.length, 5); i++) {
    const r = results[i]!;
    console.log("    Rank " + (i + 1) + ": " + r.debug);
  }

  const final = results.slice(0, limit);
  if (final.length === 0) {
    console.log("  [灵络] 融合无结果 → V5降级");
    return fallbackToV5(userInput, limit);
  }

  for (const row of final) {
    if (row.fragmentId) {
      try { recordRecall(row.fragmentId, userInput, row.finalScore, "memory-recall"); } catch {}
    }
  }

  return final.map(r => ({
    content: r.content,
    score: r.finalScore,
    source: r.source,
  }));
}

// ═══════════════════════════════════════════
// V5 降级
// ═══════════════════════════════════════════

async function fallbackToV5(
  userInput: string,
  limit: number,
): Promise<RecallResult[]> {
  console.log("  [V5] 降级检索...");
  try {
    const projectId = getCurrentProjectId();
    const profileId = getCurrentProfileId();
    const results: SearchResult[] = await explicitSearch(
      userInput, projectId, undefined, limit * 2,
    );
    const scopedResults = results.filter((result) => isFragmentInScope(result.fragment.id, projectId, profileId));
    if (scopedResults.length === 0) { console.log("  [V5] 0 results"); return []; }
    return scopedResults.map(r => ({
      content: r.fragment.summary,
      score: r.score,
      source: "v5_retriever" as const,
    }));
  } catch (e: any) {
    console.log("  [V5] error: " + e.message);
    return [];
  }
}

// ═══════════════════════════════════════════
// 碎片查询
// ═══════════════════════════════════════════

async function searchFragmentsForNode(
  nodeId: string,
  limit: number,
): Promise<Array<{ fragmentId: string; content: string }>> {
  const db = getDb();
  const projectId = getCurrentProjectId();
  const profileId = getCurrentProfileId();
  try {
    const rows = db.prepare(
      "SELECT f.id, summary, context_window FROM fragments_fts fts JOIN fragments f ON fts.rowid = f.rowid WHERE fragments_fts MATCH ? AND f.project_id = ? AND f.profile_id = ? AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted' ORDER BY rank LIMIT ?"
    ).all('"' + nodeId + '"', projectId, profileId, limit) as Array<{ id: string; summary: string; context_window: string | null }>;
    if (rows.length > 0) {
      return rows.map(r => ({
        fragmentId: r.id,
        content: r.summary + (r.context_window ? "\n[上下文] " + r.context_window : ""),
      }));
    }
  } catch { /* fragments_fts may not exist */ }
  try {
    const rows = db.prepare(
      "SELECT id, summary, context_window FROM fragments WHERE summary LIKE ? AND project_id = ? AND profile_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted' LIMIT ?"
    ).all("%" + nodeId + "%", projectId, profileId, limit) as Array<{ id: string; summary: string; context_window: string | null }>;
    return rows.map(r => ({
      fragmentId: r.id,
      content: r.summary + (r.context_window ? "\n[上下文] " + r.context_window : ""),
    }));
  } catch { return []; }
}

// ═══════════════════════════════════════════
// 兼容旧接口
// ═══════════════════════════════════════════

export async function searchMemories(
  query: string, limit: number = 5,
): Promise<string[]> {
  const results = await recallFromCognitiveGraph(query, limit);
  return results.map(r => r.content);
}

// ═══════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════

export function ensureMemorySchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS lingxi_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS lingxi_memories_fts USING fts5(content, content=lingxi_memories, content_rowid=id, tokenize='trigram')",
    );
  } catch {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS lingxi_memories_fts USING fts5(content, content=lingxi_memories, content_rowid=id)",
    );
  }
}
