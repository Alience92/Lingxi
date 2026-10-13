// 灵络 Signal Mapping — 灵眸标签 → 图引擎信号 (Opus Step 1)
// 方案 A: 规则映射, 不改 ONNX 模型。方案 B 留作未来深度集成。

export interface DeltaSignal {
  delta: number;          // -1.0 (strong negative) to +1.0 (strong positive)
  confidence: number;     // 0-1, how certain the signal is
  anchors: string[];      // 1-3 core concepts mapped to graph node IDs
  reason: string;         // human-readable reason for the signal
}

// ── Signal Mapping ────────────────────────────────

const MOOD_DELTA: Record<string, number> = {
  "frustration":  -0.9,
  "correction":   -0.8,
  "concerned":    -0.4,
  "tired":        -0.2,
  "neutral":       0.0,
  "curious":      +0.3,
  "excited":      +0.6,
  "flow":         +0.2,
};

const EVENT_DELTA: Record<string, number> = {
  "user_correction":   -0.85,  // 用户说"不对""不是那个意思"
  "user_confirmation": +0.5,   // 用户说"对""就是这样"
  "user_frustration":  -0.9,   // 情绪化纠正
  "user_explicit_rule":-0.7,   // 用户说"以后不要X""下次要Y"
  "task_completed":    +0.3,   // 任务顺利完成
  "new_fact":          +0.15,  // 中性新信息
  "silence_dismiss":   -0.1,   // 用户无视了建议
};

/**
 * Map 灵眸的输出 → 灵络 驱动信号
 * @param mood — 灵眸情绪标签 (e.g. "frustration", "flow")
 * @param eventType — 事件类型 (e.g. "user_correction", "task_completed")
 * @param userMessage — 用户原始消息 (提取 anchors)
 * @returns DeltaSignal
 */
export function mapToDeltaSignal(
  mood: string,
  eventType: string,
  userMessage: string
): DeltaSignal {
  // 1. Delta: mood + event 取更强信号
  const moodD = MOOD_DELTA[mood] ?? 0.0;
  const eventD = EVENT_DELTA[eventType] ?? 0.0;
  // 负信号取最强, 正信号取平均
  const delta = (moodD < 0 || eventD < 0)
    ? Math.min(moodD, eventD)
    : (moodD + eventD) / 2;

  // 2. Confidence: 情绪信号强度 + 事件明确度
  const confidence = Math.min(
    Math.abs(moodD) * 0.6 + Math.abs(eventD) * 0.4,
    1.0
  );

  // 3. Anchors: code tokens + CJK words + repeated bigrams, top N by priority
  const anchors = extractAnchors(userMessage);

  return {
    delta: Math.max(-1.0, Math.min(1.0, delta)),
    confidence: Math.max(0.1, confidence),
    anchors,
    reason: `${mood}/${eventType} → Δ=${delta.toFixed(2)}`,
  };
}

// ── Anchor Extraction ─────────────────────────────

function extractAnchors(text: string, maxAnchors: number = 3): string[] {
  const concepts: string[] = [];

  // 1. Code tokens: ONLY extract identifiers that look like code (not natural English)
  //    Must match one of: camelCase, PascalCase, snake_case, .ext, UPPER_CASE
  //    Plain lowercase English words → skip (they're description, not anchors)
  const codeTokens = text.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) || [];
  const STOP_WORDS = new Set([
    "the","and","for","are","was","you","all","not","but","can","did","get",
    "got","has","had","her","him","his","how","its","let","may","our","out",
    "see","she","too","use","way","who","will","that","this","with","from",
    "have","been","were","they","what","when","where","which","about","also",
    "into","just","like","make","more","new","one","only","over","some","such",
    "than","then","them","very","well","your","here","there","after","being",
    "does","each","most","name","same","take","know","much","must","need","part",
    "say","set"
  ]);
  for (const t of codeTokens) {
    if (STOP_WORDS.has(t.toLowerCase())) continue;
    // Code-like patterns: camelCase, PascalCase, snake_case, .ext, UPPER_CASE
    const isCodeLike =
      /[a-z][A-Z]/.test(t) ||         // camelCase (useState)
      /^[A-Z][a-z]+[A-Z]/.test(t) ||  // PascalCase (HandleRace)
      /_/.test(t) ||                   // snake_case or UPPER_CASE
      /\./.test(t) ||                  // file ext (auth.ts, config.json)
      /^[A-Z]{2,4}$/.test(t);          // Acronym (API, CLI, HTML)
    if (isCodeLike && t.length >= 3) {
      concepts.push(t);
    }
    // Plain English words (all lowercase, mixed case without camel): skip
  }

  // 2. Full CJK words (3+ chars) — whole words first, this is the primary signal
  const cjkWords = text.match(/[一-鿿]{3,}/g) || [];
  concepts.push(...cjkWords);

  // 3. CJK bigrams — only those appearing ≥2 times AND forming a known pattern
  //    Single-occurrence bigrams are almost always noise from sliding window
  const bigrams = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    if (/[一-鿿]/.test(text[i]!) && /[一-鿿]/.test(text[i+1]!)) {
      const bg = text[i]! + text[i+1]!;
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
  }
  // Only add repeated bigrams, and only as backfill if we don't have enough concepts
  const frequentBigrams = [...bigrams.entries()]
    .filter(([, freq]) => freq >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([bg]) => bg);
  concepts.push(...frequentBigrams);

  // Deduplicate, priority: CJK words > code tokens > bigrams, max out
  return [...new Set(concepts)].slice(0, maxAnchors);
}

// ── 快捷 API ──────────────────────────────────────

/**
 * 用户纠正了 AI 的回复 — 生成强负信号
 */
export function signalCorrection(userMessage: string): DeltaSignal {
  return {
    delta: -0.85,
    confidence: 0.9,
    anchors: extractAnchors(userMessage),
    reason: `user_correction → Δ=-0.85`,
  };
}

/**
 * 用户认可了 AI 的回复 — 生成正信号
 */
export function signalConfirmation(userMessage: string): DeltaSignal {
  return {
    delta: +0.5,
    confidence: 0.7,
    anchors: extractAnchors(userMessage),
    reason: `user_confirmation → Δ=+0.5`,
  };
}

/**
 * 用户明确给出行为指令 ("以后不要X", "下次要Y")
 */
export function signalExplicitRule(userMessage: string): DeltaSignal {
  return {
    delta: -0.7,
    confidence: 0.95,
    anchors: extractAnchors(userMessage),
    reason: `user_explicit_rule → Δ=-0.7`,
  };
}
