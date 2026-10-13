import { getDb } from "../db/connection.js";

type RetrievalState = "active" | "warm" | "archived" | "cold";
type ModelDimension = "preference" | "rule" | "goal" | "style" | "boundary" | "identity";

interface HourglassOptions {
  projectId: string;
  profileId?: string;
  now?: number;
}

interface FragmentRow {
  id: string;
  session_id: string;
  summary: string;
  subtype: "decision" | "todo" | "preference" | null;
  retrieval_state: RetrievalState;
  created_at: number;
  last_recalled_at: number | null;
  recalled_count: number;
  decay_score: number;
}

export interface HourglassStats {
  active: number;
  warm: number;
  archived: number;
  cold: number;
  warmed: number;
  archivedThisRound: number;
  cooled: number;
  reactivated: number;
}

export interface UserModelStats {
  created: number;
  reinforced: number;
  evidenceLinked: number;
  superseded: number;
  degraded: number;
}

export interface UserModelCandidate {
  id: string;
  dimension: ModelDimension;
  text: string;
  confidence: number;
  evidenceCount: number;
  score: number;
}

const ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
const WARM_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_MS = 90 * 24 * 60 * 60 * 1000;

function getCurrentProfileId(profileId?: string): string {
  return profileId || process.env.LINGXI_PROFILE_ID || "user_default";
}

function classifyHourglass(row: FragmentRow, now: number): { state: RetrievalState; score: number; reactivated: boolean } {
  const lastActive = row.last_recalled_at || row.created_at;
  const elapsed = now - lastActive;
  if (row.last_recalled_at && elapsed < ACTIVE_MS) return { state: "active", score: 1.5, reactivated: row.retrieval_state !== "active" };
  if (elapsed < ACTIVE_MS) return { state: "active", score: 1.2, reactivated: false };
  if (elapsed < WARM_MS) return { state: "warm", score: row.recalled_count > 0 ? 0.8 : 0.55, reactivated: false };
  if (elapsed < ARCHIVE_MS) return { state: "archived", score: 0, reactivated: false };
  return { state: "cold", score: 0, reactivated: false };
}

export function runFragmentHourglass(options: HourglassOptions): HourglassStats {
  const db = getDb();
  const now = options.now ?? Date.now();
  const profileId = getCurrentProfileId(options.profileId);
  const rows = db.prepare(`
    SELECT id, summary, subtype, retrieval_state, created_at, last_recalled_at, recalled_count, decay_score
    FROM fragments
    WHERE project_id = ? AND profile_id = ? AND asset_state != 'user_deleted'
      AND session_id != 'reflection_cycle'
      AND retrieval_state IN ('active','warm','archived')
  `).all(options.projectId, profileId) as FragmentRow[];

  const stats: HourglassStats = { active: 0, warm: 0, archived: 0, cold: 0, warmed: 0, archivedThisRound: 0, cooled: 0, reactivated: 0 };
  const update = db.prepare("UPDATE fragments SET retrieval_state = ?, decay_score = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const row of rows) {
      const next = classifyHourglass(row, now);
      stats[next.state]++;
      if (next.reactivated) stats.reactivated++;
      if (row.retrieval_state !== next.state) {
        if (next.state === "warm") stats.warmed++;
        if (next.state === "archived") stats.archivedThisRound++;
        if (next.state === "cold") stats.cooled++;
      }
      if (row.retrieval_state !== next.state || row.decay_score !== next.score) {
        update.run(next.state, next.score, row.id);
      }
    }
  });
  tx();
  return stats;
}

function inferDimension(text: string, subtype: FragmentRow["subtype"]): ModelDimension | null {
  if (subtype === "preference") {
    if (/(沟通|口吻|风格|回答|表达|语气|措辞|反馈|简洁|直接)/.test(text)) return "style";
    if (/(边界|不要|不能|禁止|避免)/.test(text)) return "boundary";
    return "preference";
  }
  if (subtype === "decision") return "rule";
  if (subtype === "todo") return "goal";
  if (/(我是|用户是|身份|角色|工程师|设计师|产品|非技术)/.test(text)) return "identity";
  return null;
}

function normalizeModelText(text: string): string {
  return text
    .replace(/\s*\[turn \d+\]/g, "")
    .replace(/第\d+次/g, "")
    .replace(/[。！？!?.]+$/g, "")
    .trim()
    .slice(0, 140);
}

function modelFingerprint(text: string): string {
  return normalizeModelText(text)
    .toLowerCase()
    .replace(/[\s，,。.!！?？、：:；;"'“”‘’（）()\[\]【】]+/g, "")
    .slice(0, 96);
}

function getPriority(dimension: ModelDimension, sessionCount: number, evidenceCount: number, recalled: number): number {
  if (dimension === "boundary") return 10;
  if (dimension === "identity") return 20;
  if (dimension === "rule" && (sessionCount >= 2 || recalled >= 2)) return 25;
  if (sessionCount >= 2 && evidenceCount >= 2) return 35;
  return 50;
}

function hasConflict(existing: string, incoming: string): boolean {
  const negative = /(不要|不能|禁止|避免|不喜欢|别|无需|不需要|不要主动|不能主动)/;
  const positive = /(可以|允许|默认|主动|喜欢|需要|应该|必须|希望)/;
  const existingNegative = negative.test(existing);
  const incomingNegative = negative.test(incoming);
  if (existingNegative === incomingNegative) return false;
  const existingTokens = new Set([...modelFingerprint(existing)]);
  const incomingTokens = new Set([...modelFingerprint(incoming)]);
  let overlap = 0;
  for (const token of incomingTokens) if (existingTokens.has(token)) overlap++;
  const denominator = Math.max(1, Math.min(existingTokens.size, incomingTokens.size));
  return overlap / denominator >= 0.45 && (positive.test(existing) || positive.test(incoming));
}

function refreshUserModelEvidence(projectId: string, profileId: string, now: number): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, evidence_ids FROM user_memory_models
    WHERE project_id = ? AND profile_id = ? AND status != 'deleted'
  `).all(projectId, profileId) as Array<{ id: string; evidence_ids: string }>;
  let degraded = 0;
  for (const row of rows) {
    const ids = JSON.parse(row.evidence_ids || "[]") as string[];
    if (ids.length === 0) continue;
    const activeIds: string[] = [];
    const sessions = new Set<string>();
    for (const id of ids) {
      const fragment = db.prepare(`
        SELECT session_id FROM fragments
        WHERE id = ? AND project_id = ? AND profile_id = ? AND asset_state != 'user_deleted'
      `).get(id, projectId, profileId) as { session_id: string } | undefined;
      if (!fragment) continue;
      activeIds.push(id);
      sessions.add(fragment.session_id);
    }
    if (activeIds.length === ids.length) continue;
    const status = activeIds.length === 0 ? "deleted" : sessions.size >= 2 ? "active" : "probation";
    const confidence = activeIds.length === 0 ? 0 : Math.min(0.95, 0.4 + activeIds.length * 0.08 + sessions.size * 0.06);
    db.prepare(`
      UPDATE user_memory_models
      SET status = ?, confidence = ?, evidence_count = ?, source_fragment_count = ?, source_session_count = ?, evidence_ids = ?, updated_at = ?
      WHERE id = ?
    `).run(status, confidence, activeIds.length, activeIds.length, sessions.size, JSON.stringify(activeIds), now, row.id);
    degraded++;
  }
  return degraded;
}

function modelScore(query: string, text: string, dimension: ModelDimension, confidence: number, evidenceCount: number): number {
  const chars = new Set([...query].filter((ch) => /[一-鿿a-zA-Z0-9]/.test(ch)));
  let overlap = 0;
  for (const ch of new Set([...text].filter((c) => /[一-鿿a-zA-Z0-9]/.test(c)))) {
    if (chars.has(ch)) overlap++;
  }
  const lexical = chars.size > 0 ? overlap / chars.size : 0;
  const dimensionBoost =
    dimension === "style" && /(沟通|口吻|风格|回答|表达|语气|措辞|反馈|回复)/.test(query) ? 0.25 :
    dimension === "rule" && /(规则|默认|确认|必须|禁止|允许|应该|提交|推送)/.test(query) ? 0.22 :
    dimension === "preference" && /(偏好|喜欢|不喜欢|希望|想要)/.test(query) ? 0.20 :
    dimension === "goal" && /(目标|计划|待办|下一步|优先|截止)/.test(query) ? 0.18 : 0;
  return lexical * 0.55 + confidence * 0.30 + Math.min(evidenceCount, 6) * 0.025 + dimensionBoost;
}

export function internalizeUserModels(projectId: string, profileId = getCurrentProfileId()): UserModelStats {
  const db = getDb();
  const now = Date.now();
  const degraded = refreshUserModelEvidence(projectId, profileId, now);
  const rows = db.prepare(`
    SELECT id, session_id, summary, subtype, retrieval_state, created_at, last_recalled_at, recalled_count, decay_score
    FROM fragments
    WHERE project_id = ? AND profile_id = ? AND asset_state != 'user_deleted'
      AND retrieval_state IN ('active','warm')
      AND session_id != 'reflection_cycle'
      AND (subtype IS NOT NULL OR recalled_count > 0)
    ORDER BY created_at DESC LIMIT 1000
  `).all(projectId, profileId) as FragmentRow[];

  const groups = new Map<string, { dimension: ModelDimension; text: string; fingerprint: string; ids: string[]; sessions: Set<string>; recalled: number }>();
  for (const row of rows) {
    const dimension = inferDimension(row.summary, row.subtype);
    if (!dimension) continue;
    const text = normalizeModelText(row.summary);
    if (text.length < 6) continue;
    const fingerprint = modelFingerprint(text);
    if (fingerprint.length < 6) continue;
    const key = `${dimension}:${fingerprint}`;
    const group = groups.get(key) ?? { dimension, text, fingerprint, ids: [], sessions: new Set<string>(), recalled: 0 };
    group.ids.push(row.id);
    group.sessions.add(row.session_id);
    group.recalled += row.recalled_count;
    groups.set(key, group);
  }

  let created = 0;
  let reinforced = 0;
  let evidenceLinked = 0;
  let superseded = 0;
  const upsert = db.transaction(() => {
    for (const group of groups.values()) {
      const isHighValueSingle = (group.dimension === "boundary" || group.dimension === "rule") && group.recalled >= 1;
      if (group.ids.length < 2 && group.recalled < 2 && !isHighValueSingle) continue;
      const sessionCount = group.sessions.size;
      const status = sessionCount >= 2 || group.recalled >= 2 || group.dimension === "boundary" ? "active" : "probation";
      const priority = getPriority(group.dimension, sessionCount, group.ids.length, group.recalled);
      const existing = db.prepare(`
        SELECT id, evidence_ids, evidence_count, confidence, status FROM user_memory_models
        WHERE project_id = ? AND profile_id = ? AND dimension = ? AND fingerprint = ?
      `).get(projectId, profileId, group.dimension, group.fingerprint) as { id: string; evidence_ids: string; evidence_count: number; confidence: number; status: string } | undefined;
      const evidenceIds = existing ? new Set<string>(JSON.parse(existing.evidence_ids || "[]")) : new Set<string>();
      for (const id of group.ids) evidenceIds.add(id);
      const evidence = [...evidenceIds];
      const confidence = Math.min(0.95, 0.35 + evidence.length * 0.08 + sessionCount * 0.08 + Math.min(group.recalled, 5) * 0.03 + (status === "active" ? 0.06 : 0));
      if (existing) {
        db.prepare(`
          UPDATE user_memory_models
          SET status = CASE WHEN status IN ('deleted','superseded') THEN status ELSE ? END,
              priority = MIN(priority, ?),
              confidence = MAX(confidence, ?),
              evidence_count = ?,
              source_fragment_count = ?,
              source_session_count = MAX(source_session_count, ?),
              evidence_ids = ?,
              last_reinforced_at = ?,
              updated_at = ?
          WHERE id = ?
        `).run(status, priority, confidence, evidence.length, evidence.length, sessionCount, JSON.stringify(evidence), now, now, existing.id);
        reinforced++;
      } else {
        const conflicts = db.prepare(`
          SELECT id, text FROM user_memory_models
          WHERE project_id = ? AND profile_id = ? AND dimension = ? AND status IN ('active','probation') AND superseded_by IS NULL
        `).all(projectId, profileId, group.dimension) as Array<{ id: string; text: string }>;
        const id = `umm_${now}_${Math.random().toString(36).slice(2, 8)}`;
        db.prepare(`
          INSERT INTO user_memory_models (id, project_id, profile_id, dimension, fingerprint, text, status, priority, confidence, evidence_count, source_fragment_count, source_session_count, evidence_ids, last_reinforced_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, projectId, profileId, group.dimension, group.fingerprint, group.text, status, priority, confidence, evidence.length, evidence.length, sessionCount, JSON.stringify(evidence), now, now, now);
        for (const conflict of conflicts) {
          if (!hasConflict(conflict.text, group.text)) continue;
          db.prepare(`
            UPDATE user_memory_models
            SET status = 'superseded', superseded_by = ?, last_conflict_at = ?, updated_at = ?
            WHERE id = ?
          `).run(id, now, now, conflict.id);
          superseded++;
        }
        created++;
      }
      evidenceLinked += group.ids.length;
      if (group.ids.length >= 2) {
        const placeholders = group.ids.map(() => "?").join(",");
        db.prepare(`UPDATE fragments SET status = 'distilled', distilled_to = COALESCE(distilled_to, 'user_memory_model') WHERE id IN (${placeholders})`).run(...group.ids);
      }
    }
  });
  upsert();
  return { created, reinforced, evidenceLinked, superseded, degraded };
}

export function searchUserModels(query: string, projectId: string, profileId = getCurrentProfileId(), limit = 3): UserModelCandidate[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, dimension, text, confidence, evidence_count
    FROM user_memory_models
    WHERE project_id = ? AND profile_id = ? AND confidence >= 0.5
      AND status = 'active' AND superseded_by IS NULL
    ORDER BY priority ASC, confidence DESC, evidence_count DESC, updated_at DESC LIMIT 80
  `).all(projectId, profileId) as Array<{ id: string; dimension: ModelDimension; text: string; confidence: number; evidence_count: number }>;
  return rows
    .map((row) => ({
      id: row.id,
      dimension: row.dimension,
      text: row.text,
      confidence: row.confidence,
      evidenceCount: row.evidence_count,
      score: modelScore(query, row.text, row.dimension, row.confidence, row.evidence_count),
    }))
    .filter((row) => row.score >= 0.38)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
