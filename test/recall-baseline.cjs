// Recall@5 baseline test — 5 queries covering different retrieval dimensions.
// Run: node test/recall-baseline.js
// This is the baseline. Don't tune parameters to make numbers look better.

const { openDb, getDb } = require("../dist/db/connection.js");
const { explicitSearch } = require("../dist/core/retriever.js");
const { Embedder } = require("../dist/core/embedder.js");

const TEST_CASES = [
  {
    id: "Q1-known-decision",
    query: "skill体系认证模式",
    description: "已知决策：skill体系iOS封闭认证",
    shouldFind: true,
    expectKeywords: ["skill", "认证", "iOS", "封闭"],
  },
  {
    id: "Q2-non-existent",
    query: "量子计算在游戏引擎中的应用",
    description: "不存在话题：用户从未讨论过",
    shouldFind: false,
    expectKeywords: [],
  },
  {
    id: "Q3-old-topic",
    query: "用户工作习惯和作息规律",
    description: "旧话题：工作模式和作息偏好",
    shouldFind: true,
    expectKeywords: ["工作", "作息", "熬夜", "提醒"],
  },
  {
    id: "Q4-alias",
    query: "MEM-SYM是什么",
    description: "别名测试：MEM-SYM应匹配灵犀",
    shouldFind: true,
    expectKeywords: ["灵犀", "MEM-SYM", "记忆"],
  },
  {
    id: "Q5-feel",
    query: "用户纠正过Agent哪些错误行为",
    description: "FEEL通道：用户纠正和反馈",
    shouldFind: true,
    expectKeywords: ["纠正", "错误", "不要", "讨论"],
  },
];

async function main() {
  openDb();
  const db = getDb();

  // Initialize embedder (needed for explicitSearch)
  const apiKey = process.env.AGENTMEMORY_API_KEY || "";
  const baseURL = process.env.AGENTMEMORY_EMBEDDING_URL || "https://api.minimax.chat";
  const embedder = new Embedder(apiKey, baseURL);
  // Set as current embedder so retriever can use it
  const { setCurrentEmbedder } = require("../dist/core/embedder.js");
  setCurrentEmbedder(embedder);

  const PROJ = "C--Users-Administrator";

  console.log("=== 检索精度基线测试 ===\n");

  const results = [];
  for (const tc of TEST_CASES) {
    console.log(`[${tc.id}] ${tc.description}`);
    console.log(`  查询: "${tc.query}"`);

    try {
      const hits = await explicitSearch(tc.query, PROJ);
      console.log(`  返回: ${hits.length} 条`);

      if (hits.length > 0) {
        const top3 = hits.slice(0, 3).map(h => h.fragment.summary.slice(0, 80));
        console.log(`  Top-3:`);
        top3.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
      }

      // Check keyword presence in results
      let keywordHits = 0;
      if (tc.expectKeywords.length > 0 && hits.length > 0) {
        const allText = hits.slice(0, 5).map(h => h.fragment.summary).join(" ");
        for (const kw of tc.expectKeywords) {
          if (allText.includes(kw)) keywordHits++;
        }
      }

      if (tc.shouldFind && hits.length === 0) {
        console.log(`  ⚠️ 预期有结果但返回空`);
      }
      if (!tc.shouldFind && hits.length > 0) {
        console.log(`  ⚠️ 预期空结果但返回 ${hits.length} 条`);
      }
      if (tc.expectKeywords.length > 0) {
        console.log(`  关键词命中: ${keywordHits}/${tc.expectKeywords.length}`);
      }

      results.push({
        id: tc.id,
        returned: hits.length,
        keywordHits: tc.expectKeywords.length > 0
          ? `${keywordHits}/${tc.expectKeywords.length}`
          : "N/A",
        topSummary: hits.length > 0 ? hits[0].fragment.summary.slice(0, 80) : "(empty)",
      });
    } catch (e) {
      console.log(`  ❌ 错误: ${e.message.slice(0, 120)}`);
      results.push({ id: tc.id, returned: 0, keywordHits: "error", topSummary: e.message.slice(0, 80) });
    }

    console.log("");
  }

  console.log("=== 基线汇总 ===");
  console.log("");
  console.log("| 测试 | 返回数 | 关键词命中 | Top-1 摘要 |");
  console.log("|------|--------|-----------|-----------|");
  for (const r of results) {
    console.log(`| ${r.id} | ${r.returned} | ${r.keywordHits} | ${r.topSummary.slice(0, 60)} |`);
  }

  const foundCount = results.filter(r => r.returned > 0).length;
  console.log(`\n5 题中 ${foundCount} 题有返回结果`);
  console.log("基线记录完毕。首次不设阈值，仅记录基线。");
}

main().catch(console.error);
