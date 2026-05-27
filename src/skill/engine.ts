import type { FragmentationInput, Fragment, AliasEntry } from "../types.js";
import { getDb } from "../db/connection.js";
import { persistFragments, deleteFragment } from "../db/repository.js";
import { fragmentTranscript, type FragmentResult } from "../core/fragmenter.js";
import { computeDecayScore, CONSTITUTIONAL_WEIGHT_THRESHOLD } from "../core/decay.js";
import { updateActiveContext as updateActiveContextImpl } from "../core/active-context.js";
import { Embedder, setCurrentEmbedder, cosineSimilarity } from "../core/embedder.js";

export interface EngineConfig {
  apiKey: string;
  fragmentationKey?: string;
  fragmentationBaseURL?: string;
  model?: string;
  baseURL?: string;
}

export class MemoryEngine {
  public readonly embedder: Embedder;

  constructor(private config: EngineConfig) {
    this.embedder = new Embedder(config.apiKey, config.baseURL);
    setCurrentEmbedder(this.embedder);
  }

  canFragment(): boolean {
    const key = this.config.fragmentationKey || this.config.apiKey;
    return !!(key && key.length > 10 && key !== "test-key");
  }

  async compactSession(input: FragmentationInput): Promise<string> {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO sessions (id, project_id, started_at, pending_fragmentation) VALUES (?, ?, ?, 0)`).run(
      input.sessionId, input.projectId, Date.now()
    );
    const lines = input.transcript.split("\n").filter(l => l.startsWith("User:") || l.startsWith("Assistant:"));
    const summary = lines.slice(-6).map(l => l.slice(0, 120)).join("\n").slice(0, 800);
    db.prepare(`UPDATE sessions SET compacted_at = ?, pending_fragmentation = 1, compact_summary = ? WHERE id = ?`).run(
      Date.now(), summary, input.sessionId
    );
    return summary;
  }

  async fragmentSession(input: FragmentationInput): Promise<Fragment[]> {
    const db = getDb();
    const { output } = await this.callFragmenter(input);
    if (output.fragments.length === 0) {
      const fallback = this.buildFallbackFragment(input);
      if (fallback) {
        const persisted = await persistFragments({
          output: { fragments: [fallback], summary: fallback.summary },
          sessionId: input.sessionId,
          projectId: input.projectId,
        });
        db.prepare(`UPDATE sessions SET pending_fragmentation = 0 WHERE id = ?`).run(input.sessionId);
        if (persisted.length > 0) this.updateActiveContext(input.projectId);
        return persisted;
      }
      db.prepare(`UPDATE sessions SET pending_fragmentation = 0 WHERE id = ?`).run(input.sessionId);
      return [];
    }

    return await persistFragments({
      output,
      sessionId: input.sessionId,
      projectId: input.projectId,
    }).then((persisted) => {
      if (persisted.length > 0) this.updateActiveContext(input.projectId);
      return persisted;
    });
  }

  private buildFallbackFragment(input: FragmentationInput) {
    const text = input.transcript.trim();
    const meaningfulLines = text.split("\n").filter(
      (l) => l.startsWith("User:") || l.startsWith("Assistant:")
    );
    if (meaningfulLines.length < 5) return null;

    const sample = meaningfulLines
      .slice(0, 10)
      .map((l) => l.slice(0, 100))
      .join("; ");
    const summary = sample.slice(0, 50);

    return {
      id: `fallback-${input.sessionId.slice(0, 8)}-${Date.now()}`,
      sessionId: input.sessionId,
      projectId: input.projectId,
      anchors: [{
        channel: "WHAT" as const,
        label: `会话摘要: ${summary}`,
        weight: 10,
        source: "clustering" as const,
        timestamp: Date.now(),
      }],
      linkedIds: [] as string[],
      linkedCount: 0,
      summary,
      createdAt: Date.now(),
    };
  }

  runDecay(options?: { protectConstitutional?: boolean }): { archived: number; deleted: number } {
    const protectConstitutional = options?.protectConstitutional ?? false;
    const db = getDb();

    let rows: Array<Record<string, unknown>>;
    let protectedIds: Set<string> = new Set();

    if (protectConstitutional) {
      const constitutional = db.prepare(`
        SELECT DISTINCT fa.fragment_id FROM fragment_anchors fa
        WHERE fa.channel = 'FEEL' AND fa.weight >= ${CONSTITUTIONAL_WEIGHT_THRESHOLD}
      `).all() as Array<{ fragment_id: string }>;
      protectedIds = new Set(constitutional.map(r => r.fragment_id));
    }

    rows = db.prepare(`SELECT * FROM fragments WHERE status IN ('active', 'distilled')`).all() as Array<Record<string, unknown>>;

    const weightMap = new Map<string, number>();
    const weightRows = db.prepare(`
      SELECT fragment_id, MAX(weight) as max_weight
      FROM fragment_anchors GROUP BY fragment_id
    `).all() as Array<{ fragment_id: string; max_weight: number }>;
    for (const w of weightRows) {
      weightMap.set(w.fragment_id, w.max_weight);
    }

    let archived = 0;
    let deleted = 0;

    const update = db.transaction(() => {
      for (const r of rows) {
        const id = r.id as string;
        if (protectedIds.has(id)) continue;

        const createdAt = r.created_at as number;
        const lastRecalledAt = r.last_recalled_at as number | null;
        const recalledCount = r.recalled_count as number;
        const status = r.status as string;
        const anchorWeight = weightMap.get(id) ?? 10;

        const decay = computeDecayScore(createdAt, lastRecalledAt, recalledCount, anchorWeight);
        if (decay.status === "archived" && status !== "archived") {
          db.prepare(`UPDATE fragments SET status = 'archived', decay_score = 0 WHERE id = ?`).run(id);
          archived++;
        } else if (decay.status === "deleted") {
          deleteFragment(id);
          deleted++;
        }
      }
    });

    update();
    return { archived, deleted };
  }

  runDistillation(projectId: string): number {
    const db = getDb();
    const fragments = db.prepare(`
      SELECT f.id, f.summary, MIN(fa.label) AS label, MIN(fa.channel) AS channel
      FROM fragments f
      JOIN fragment_anchors fa ON fa.fragment_id = f.id
      WHERE f.project_id = ? AND f.status = 'active'
      GROUP BY f.id, f.summary
    `).all(projectId) as Array<{ id: string; summary: string; label: string; channel: string }>;

    const groups = new Map<string, Array<{ id: string; summary: string; label: string; channel: string }>>();
    for (const f of fragments) {
      const key = `${f.channel}:${(f.label || f.summary).slice(0, 15)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ id: f.id, summary: f.summary, label: f.label, channel: f.channel });
    }

    let distilled = 0;
    for (const [groupKey, members] of groups) {
      if (members.length >= 3) {
        const exemplar = members[0];
        const labelBase = groupKey.split(":").slice(1).join(":");
        const channel = exemplar?.channel ?? "WHAT";
        const fingerprint = `${projectId}::${channel}::${labelBase.trim().toLowerCase()}`;

        const existingRule = db.prepare(`SELECT id FROM distilled_rules WHERE fingerprint = ?`).get(fingerprint) as { id: string } | undefined;
        if (existingRule) {
          for (const m of members) {
            db.prepare(`INSERT OR IGNORE INTO rule_sources (rule_id, fragment_id, project_id) VALUES (?, ?, ?)`).run(
              existingRule.id, m.id, projectId
            );
            db.prepare(`UPDATE fragments SET status = 'distilled', distilled_to = ? WHERE id = ?`).run(
              existingRule.id, m.id
            );
          }
          continue;
        }

        const ruleText = members.map((m) => m.summary).join("; ").slice(0, 100);
        const ruleId = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        db.prepare(`INSERT OR IGNORE INTO distilled_rules (id, fingerprint, text, weight, created_at) VALUES (?, ?, ?, 1.0, ?)`).run(
          ruleId, fingerprint, ruleText, Date.now()
        );
        for (const m of members) {
          db.prepare(`INSERT OR IGNORE INTO rule_sources (rule_id, fragment_id, project_id) VALUES (?, ?, ?)`).run(
            ruleId, m.id, projectId
          );
          db.prepare(`UPDATE fragments SET status = 'distilled', distilled_to = ? WHERE id = ?`).run(
            ruleId, m.id
          );
        }
        distilled++;
      }
    }
    return distilled;
  }

  getTrustProfile(projectId: string) {
    const db = getDb();
    const profile = db.prepare(`SELECT * FROM trust_profile WHERE project_id = ?`).get(projectId) as Record<string, unknown> | undefined;

    if (!profile) {
      const now = Date.now();
      db.prepare(`INSERT INTO trust_profile (project_id, created_at, updated_at) VALUES (?, ?, ?)`).run(projectId, now, now);
      return {
        projectId,
        confirmCount: 0,
        autoDecisionCount: 0,
        correctCount: 0,
        wrongCount: 0,
        autonomyLevel: 1,
      };
    }

    return {
      projectId: profile.project_id as string,
      confirmCount: profile.confirm_count as number,
      autoDecisionCount: profile.auto_decision_count as number,
      correctCount: profile.correct_count as number,
      wrongCount: profile.wrong_count as number,
      autonomyLevel: profile.autonomy_level as number,
    };
  }

  recordDecision(projectId: string, wasAuto: boolean, wasCorrect: boolean) {
    const db = getDb();

    const result = db.transaction(() => {
      const profile = this.getTrustProfile(projectId);

      let confirm = profile.confirmCount;
      let auto = profile.autoDecisionCount;
      let correct = profile.correctCount;
      let wrong = profile.wrongCount;

      if (wasAuto) { auto++; } else { confirm++; }
      if (wasCorrect) { correct++; } else { wrong++; }

      let level = profile.autonomyLevel;
      if (level === 1 && confirm >= 3) { level = 2; }
      if (level === 2 && correct >= 5 && correct / Math.max(1, correct + wrong) > 0.8) { level = 3; }
      if (level === 3 && correct / Math.max(1, correct + wrong) < 0.6) { level = 2; }

      const now = Date.now();
      db.prepare(`
        UPDATE trust_profile SET
          confirm_count = ?, auto_decision_count = ?, correct_count = ?, wrong_count = ?,
          autonomy_level = ?, last_decision_at = ?, updated_at = ?
        WHERE project_id = ?
      `).run(confirm, auto, correct, wrong, level, now, now, projectId);

      return { ...profile, confirmCount: confirm, autoDecisionCount: auto, correctCount: correct, wrongCount: wrong, autonomyLevel: level };
    })();

    return result;
  }

  getConstitutionalFragments(projectId: string): Array<{ fragmentId: string; label: string; weight: number }> {
    const db = getDb();
    return db.prepare(`
      SELECT fa.fragment_id as fragmentId, fa.label, fa.weight
      FROM fragment_anchors fa
      JOIN fragments f ON f.id = fa.fragment_id
      WHERE fa.channel = 'FEEL' AND fa.weight >= ${CONSTITUTIONAL_WEIGHT_THRESHOLD} AND f.status = 'active' AND f.project_id = ?
      ORDER BY fa.weight DESC
    `).all(projectId) as Array<{ fragmentId: string; label: string; weight: number }>;
  }

  isConstitutional(fragmentId: string): boolean {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM fragment_anchors
      WHERE fragment_id = ? AND channel = 'FEEL' AND weight >= 80
    `).get(fragmentId) as { cnt: number };
    return row.cnt > 0;
  }

  getDecisionCriteria(projectId: string, subject: string) {
    const db = getDb();
    const escaped = subject.replace(/[%_]/g, "\\$&");
    const criteria = db.prepare(`
      SELECT * FROM decision_criteria
      WHERE project_id = ? AND (subject = ? OR subject LIKE '%' || ? || '%' ESCAPE '\\')
      ORDER BY confidence DESC, created_at DESC
    `).all(projectId, subject, escaped) as Array<Record<string, unknown>>;

    if (criteria.length === 0) return null;

    const best = criteria[0]!;
    return {
      id: best.id as string,
      subject: best.subject as string,
      target: best.target as string,
      criteriaType: best.criteria_type as string,
      criteriaValue: best.criteria_value as string,
      confidence: best.confidence as number,
      source: best.source as string,
    };
  }

  async findClosestEntity(projectId: string, subject: string): Promise<{
    subject: string; target: string; criteriaType: string; criteriaValue: string;
    confidence: number; similarity: number;
  } | null> {
    const db = getDb();
    const allWithEmb = db.prepare(`
      SELECT * FROM decision_criteria
      WHERE project_id = ? AND entity_embedding IS NOT NULL
    `).all(projectId) as Array<Record<string, unknown>>;

    if (allWithEmb.length === 0) return null;

    const queryVec = await this.embedder.embed(subject, "query");

    let bestSim = 0;
    let bestMatch: Record<string, unknown> | null = null;
    for (const row of allWithEmb) {
      const blob = row.entity_embedding as Buffer;
      if (!blob || blob.length < 4) continue;
      const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
      const sim = cosineSimilarity(queryVec, Array.from(floats));
      if (sim > bestSim && sim > 0.6) {
        bestSim = sim;
        bestMatch = row;
      }
    }

    if (!bestMatch) return null;
    return {
      subject: bestMatch.subject as string,
      target: bestMatch.target as string,
      criteriaType: bestMatch.criteria_type as string,
      criteriaValue: bestMatch.criteria_value as string,
      confidence: (bestMatch.confidence as number) * bestSim,
      similarity: bestSim,
    };
  }

  async recordDecisionCriteria(params: {
    projectId: string; subject: string; target: string;
    criteriaType: string; criteriaValue: string; confidence?: number; source?: string; sessionId?: string;
  }) {
    const db = getDb();
    const id = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    let entityEmb: Buffer | null = null;
    try {
      const vec = await this.embedder.embed(params.subject, "store");
      entityEmb = Buffer.from(new Float32Array(vec).buffer);
    } catch {}

    db.prepare(`
      INSERT INTO decision_criteria (id, project_id, subject, target, criteria_type, criteria_value, confidence, source, session_id, entity_embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.projectId, params.subject, params.target,
      params.criteriaType, params.criteriaValue,
      params.confidence ?? 0.5, params.source ?? "user", params.sessionId ?? null, entityEmb, Date.now()
    );
    return { id, ...params };
  }

  updateActiveContext(projectId: string): void {
    updateActiveContextImpl(projectId);
  }

  // ── Alias System ─────────────────────────────────

  addAlias(projectId: string, canonical: string, alias: string, source: "manual" | "auto" = "manual", confidence: number = 1.0): AliasEntry {
    const db = getDb();
    const id = `alias-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.prepare("INSERT OR REPLACE INTO aliases (id, project_id, canonical, alias, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, projectId, canonical, alias, source, confidence, Date.now());
    return { id, projectId, canonical, alias, source, confidence, createdAt: Date.now() };
  }

  removeAlias(projectId: string, canonical: string, alias: string): boolean {
    const db = getDb();
    const result = db.prepare("DELETE FROM aliases WHERE project_id = ? AND canonical = ? AND alias = ?").run(projectId, canonical, alias);
    return result.changes > 0;
  }

  getAliases(projectId: string): AliasEntry[] {
    const db = getDb();
    return db.prepare("SELECT * FROM aliases WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as AliasEntry[];
  }

  expandQuery(query: string, projectId: string): string {
    const db = getDb();
    const aliases = db.prepare("SELECT canonical, alias FROM aliases WHERE project_id = ? AND confidence >= 0.7").all(projectId) as Array<{ canonical: string; alias: string }>;
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

  private async callFragmenter(input: FragmentationInput): Promise<FragmentResult> {
    const key = this.config.fragmentationKey || this.config.apiKey;
    if (!key || key === "test-key" || key.length <= 10) {
      return { output: { fragments: [], summary: "" }, usage: undefined };
    }
    const baseURL = this.config.fragmentationBaseURL
      || (process.env.DEEPSEEK_API_KEY ? "https://api.deepseek.com" : "https://api.minimax.chat");
    const model = this.config.model ?? (baseURL.includes("minimax") ? "MiniMax-M2.7" : "deepseek-v4-pro");
    return await fragmentTranscript(input, key, model, baseURL);
  }
}
