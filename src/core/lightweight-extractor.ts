// Lightweight signal extraction — runs per user message without LLM.
// Reuses existing regex patterns from recordFeelEvent and channel detection.
// Target: < 50ms per call. No embedding, no API calls, no DB writes in hot path.
// Signals are batched and persisted in lightweight_signals table.

import { getDb } from "../db/connection.js";

export interface LightweightSignal {
  signalType: "decision" | "correction" | "confirmation" | "frustration" | "urgency" | "file_ref" | "person_ref" | "topic";
  label: string;
  weight: number;
}

const DECISION_KW = /决定|确定|就用|选这个|定下来|按这个|这样做|就这么|敲定|定了/;
const CORRECTION_KW = /不对|错了|错误|不要|不行|不好|不该|重做|撤销|回滚|纠正|删了|改/;
const CONFIRMATION_KW = /对|好|行|可以|正确|没错|是的|好的|ok|确认|认可|同意|继续/;
const FRUSTRATION_KW = /又|总是|一直|每次|老是|永远|从来|服了|烦|够了/;
const URGENCY_KW = /快|赶紧|马上|立刻|急|紧急|现在/;
const FILE_REF_KW = /[A-Za-z]:[\\/][^\s,;]{2,}|\.ts\b|\.js\b|\.py\b|\.json\b|\.sql\b|\.md\b|\.tsx\b|src[\\/]|node_modules/;
const PERSON_REF_KW = /用户|助手|Agent|产品经理|后端|前端|PM|开发|设计师/;

// Topic extraction: meaningful CJK bigrams, deduplicated
function extractTopics(text: string): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const bg = text.slice(i, i + 2);
    if (/[一-鿿]/.test(bg[0]!) && /[一-鿿]/.test(bg[1]!)) {
      if (!seen.has(bg)) {
        seen.add(bg);
        topics.push(bg);
      }
    }
  }
  return topics.slice(0, 8); // top 8 topic bigrams
}

/** Extract lightweight signals from a single user or assistant message. */
export function extractSignals(text: string): LightweightSignal[] {
  const signals: LightweightSignal[] = [];

  // FEEL signals (reuse engine.ts recordFeelEvent patterns)
  if (CORRECTION_KW.test(text)) {
    signals.push({ signalType: "correction", label: text.slice(0, 40), weight: 80 });
  }
  if (FRUSTRATION_KW.test(text)) {
    signals.push({ signalType: "frustration", label: text.slice(0, 40), weight: 90 });
  }
  if (CONFIRMATION_KW.test(text) && !CORRECTION_KW.test(text) && !FRUSTRATION_KW.test(text)) {
    signals.push({ signalType: "confirmation", label: text.slice(0, 40), weight: 30 });
  }
  if (URGENCY_KW.test(text)) {
    signals.push({ signalType: "urgency", label: text.slice(0, 40), weight: 50 });
  }

  // Decision signals
  if (DECISION_KW.test(text)) {
    signals.push({ signalType: "decision", label: text.slice(0, 50), weight: 10 });
  }

  // WHERE signals (file/path references)
  if (FILE_REF_KW.test(text)) {
    const match = text.match(FILE_REF_KW);
    if (match) {
      signals.push({ signalType: "file_ref", label: match[0]!, weight: 10 });
    }
  }

  // WHO signals
  if (PERSON_REF_KW.test(text)) {
    signals.push({ signalType: "person_ref", label: text.slice(0, 40), weight: 10 });
  }

  // Topic bigrams as light signals
  const topics = extractTopics(text);
  for (const t of topics.slice(0, 3)) {
    signals.push({ signalType: "topic", label: t, weight: 5 });
  }

  return signals;
}

/** Persist lightweight signals to DB (batched, called from hook). */
export function persistLightweightSignals(
  projectId: string,
  sessionId: string,
  signals: LightweightSignal[],
): number {
  if (signals.length === 0) return 0;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    "INSERT INTO lightweight_signals (id, project_id, session_id, signal_type, label, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insert = db.transaction(() => {
    for (const s of signals) {
      stmt.run(
        `lw-${now}-${Math.random().toString(36).slice(2, 6)}`,
        projectId, sessionId, s.signalType, s.label, s.weight, now,
      );
    }
  });
  insert();
  return signals.length;
}
