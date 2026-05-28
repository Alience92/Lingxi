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

import { checkpointWAL } from "../db/connection.js";

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

    const persisted = await persistFragments({
      output,
      sessionId: input.sessionId,
      projectId: input.projectId,
    });
    db.prepare(`UPDATE sessions SET pending_fragmentation = 0 WHERE id = ?`).run(input.sessionId);
    if (persisted.length > 0) this.updateActiveContext(input.projectId);
    return persisted;
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

  runDecay(options?: { protectConstitutional?: boolean }): { warmed: number; archived: number; cooled: number } {
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

    rows = db.prepare(`SELECT * FROM fragments WHERE retrieval_state IN ('active', 'warm', 'archived') AND asset_state != 'user_deleted'`).all() as Array<Record<string, unknown>>;

    const weightMap = new Map<string, number>();
    const weightRows = db.prepare(`
      SELECT fragment_id, MAX(weight) as max_weight
      FROM fragment_anchors GROUP BY fragment_id
    `).all() as Array<{ fragment_id: string; max_weight: number }>;
    for (const w of weightRows) {
      weightMap.set(w.fragment_id, w.max_weight);
    }

    let warmed = 0;
    let archived = 0;
    let cooled = 0;

    const update = db.transaction(() => {
      for (const r of rows) {
        const id = r.id as string;
        if (protectedIds.has(id)) continue;

        const createdAt = r.created_at as number;
        const lastRecalledAt = r.last_recalled_at as number | null;
        const recalledCount = r.recalled_count as number;
        const currentRetrieval = r.retrieval_state as string;
        const anchorWeight = weightMap.get(id) ?? 10;

        const decay = computeDecayScore(createdAt, lastRecalledAt, recalledCount, anchorWeight);
        // Always write the computed decay_score, not just on state transitions
        db.prepare(`UPDATE fragments SET retrieval_state = ?, decay_score = ? WHERE id = ?`).run(decay.retrievalState, decay.score, id);
        if (decay.retrievalState !== currentRetrieval) {
          if (decay.retrievalState === "warm") warmed++;
          else if (decay.retrievalState === "archived") archived++;
          else if (decay.retrievalState === "cold") cooled++;
        }
      }
    });

    update();
    return { warmed, archived, cooled };
  }

  runDistillation(projectId: string, options?: { minFeelScore?: number; minMembers?: number }): number {
    const minFeelScore = options?.minFeelScore ?? 60;
    const minMembers = options?.minMembers ?? 3;
    const db = getDb();

    // Load fragments with their max FEEL weight for quality gating.
    // Includes archived — their content may form useful L0 rules even though
    // the fragments themselves are no longer in active retrieval. status and retrieval_state are independent axes.
    const fragments = db.prepare(`
      SELECT f.id, f.summary, MIN(fa.label) AS label, MIN(fa.channel) AS channel,
             MAX(CASE WHEN fa.channel = 'FEEL' THEN fa.weight ELSE NULL END) as max_feel,
             MAX(CASE WHEN fa.channel = 'FEEL' AND fa.weight >= 80 THEN 1 ELSE 0 END) as is_constitutional
      FROM fragments f
      JOIN fragment_anchors fa ON fa.fragment_id = f.id
      WHERE f.project_id = ? AND f.retrieval_state IN ('active', 'warm', 'archived') AND f.asset_state != 'user_deleted'
      GROUP BY f.id, f.summary
    `).all(projectId) as Array<{ id: string; summary: string; label: string; channel: string; max_feel: number | null; is_constitutional: number }>;

    const groups = new Map<string, Array<{ id: string; summary: string; label: string; channel: string; maxFeel: number | null; isConstitutional: boolean }>>();
    for (const f of fragments) {
      const key = `${f.channel}:${(f.label || f.summary).slice(0, 50)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({
        id: f.id, summary: f.summary, label: f.label, channel: f.channel,
        maxFeel: f.max_feel, isConstitutional: f.is_constitutional === 1,
      });
    }

    let distilled = 0;
    for (const [groupKey, members] of groups) {
      if (members.length < minMembers) continue;

      // Quality gate: average FEEL score across group must meet threshold
      const feelScores = members.map(m => m.maxFeel).filter((s): s is number => s !== null);
      const avgFeel = feelScores.length > 0 ? feelScores.reduce((a, b) => a + b, 0) / feelScores.length : 0;
      if (avgFeel < minFeelScore) continue;

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

      // Rule text: use the most representative summary (longest with highest FEEL)
      const best = members.reduce((a, b) =>
        ((a.maxFeel ?? 0) + a.summary.length * 0.01) > ((b.maxFeel ?? 0) + b.summary.length * 0.01) ? a : b
      );
      const ruleText = best!.summary.slice(0, 100);

      // Constitutional gate: rule weight based on source fragment FEEL scores
      const hasConstitutional = members.some(m => m.isConstitutional);
      const ruleWeight = hasConstitutional ? 2.0 : (avgFeel / 100);

      const ruleId = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(`INSERT OR IGNORE INTO distilled_rules (id, fingerprint, text, weight, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        ruleId, fingerprint, ruleText, ruleWeight, Date.now()
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

  // ── Relationship Profile (P1) ─────────────────────

  private defaultProfileData(): Record<string, unknown> {
    return {
      signals7d: { correction: 0, frustration: 0, urgency: 0, confirmation: 0 },
      windowStats: { totalInteractions: 0, acceptedAutonomy: 0, correctionCount: 0, highSeverityErrors: 0 },
      lastUpgradeAt: 0,
      repairStartedAt: 0,
    };
  }

  getRelationshipProfile(projectId: string, userId: string = "default"): Record<string, unknown> {
    const db = getDb();
    const row = db.prepare(
      "SELECT * FROM relationship_profiles WHERE user_id = ? AND project_id = ?"
    ).get(userId, projectId) as Record<string, unknown> | undefined;

    if (!row) {
      const now = Date.now();
      const data = this.defaultProfileData();
      db.prepare(
        "INSERT INTO relationship_profiles (user_id, project_id, trust_level, friction_score, repair_needed, autonomy_budget, profile_data, updated_at) VALUES (?, ?, 'L1', 0, 0, 0, ?, ?)"
      ).run(userId, projectId, JSON.stringify(data), now);
      return {
        userId, projectId, trustLevel: "L1", frictionScore: 0,
        repairNeeded: false, autonomyBudget: 0, ...data, updatedAt: now,
      };
    }

    const data = JSON.parse((row.profile_data as string) || "{}");
    return {
      userId: row.user_id, projectId: row.project_id,
      trustLevel: row.trust_level, frictionScore: row.friction_score,
      repairNeeded: !!(row.repair_needed), autonomyBudget: row.autonomy_budget,
      ...data, updatedAt: row.updated_at,
    };
  }

  /** Called on every FEEL classification — updates friction & autonomy counters */
  recordFeelEvent(
    projectId: string,
    label: string,
    weight: number,
    userId: string = "default",
  ): Record<string, unknown> {
    const db = getDb();
    const profile = this.getRelationshipProfile(projectId, userId) as Record<string, unknown>;
    const signals = (profile.signals7d as Record<string, number>) || { correction: 0, frustration: 0, urgency: 0, confirmation: 0 };
    const window = (profile.windowStats as Record<string, number>) || { totalInteractions: 0, acceptedAutonomy: 0, correctionCount: 0, highSeverityErrors: 0 };
    let frictionDelta = 0;
    let autonomyDelta = 0;

    window.totalInteractions = (window.totalInteractions || 0) + 1;

    // Detect FEEL sub-type from label text
    const lbl = (label || "").toLowerCase();
    const isCorrection = /纠正|不对|错了|错误|删了|改|不要|不行|不好|不该|重做|撤销|回滚/i.test(lbl);
    const isFrustration = /又|总是|一直|每次|老是|永远|从来|服了|烦|够了/i.test(lbl);
    const isConfirmation = /对|好|行|可以|正确|没错|是的|好的|ok|确认|认可|同意|继续/i.test(lbl);
    const isUrgency = /快|赶紧|马上|立刻|急|紧急|现在/i.test(lbl);
    const isHighSeverity = weight >= 80;

    if (isConfirmation) {
      signals.confirmation = (signals.confirmation || 0) + 1;
      frictionDelta = -1;
      autonomyDelta = +1;
      window.acceptedAutonomy = (window.acceptedAutonomy || 0) + 1;
    } else if (isCorrection || isFrustration) {
      if (isFrustration) {
        signals.frustration = (signals.frustration || 0) + 1;
        frictionDelta = +4;
        autonomyDelta = -2;
      } else {
        signals.correction = (signals.correction || 0) + 1;
        frictionDelta = +2;
        autonomyDelta = -2;
      }
      window.correctionCount = (window.correctionCount || 0) + 1;
      if (isHighSeverity) {
        frictionDelta = +6;
        autonomyDelta = -4;
        window.highSeverityErrors = (window.highSeverityErrors || 0) + 1;
      }
    } else if (isUrgency) {
      signals.urgency = (signals.urgency || 0) + 1;
    } else {
      // Generic FEEL — slight negative pressure (unclear feedback = mild friction)
      frictionDelta = +1;
    }

    // Apply deltas with clamping
    let newFriction = Math.max(0, Math.min(10, (profile.frictionScore as number) + frictionDelta));
    let newAutonomy = Math.max(0, Math.min(10, (profile.autonomyBudget as number) + autonomyDelta));

    // Autonomy cap when friction is high
    if (newFriction >= 6) {
      newAutonomy = Math.min(newAutonomy, 10 - newFriction / 2);
    }

    // Check repairNeeded
    let repairNeeded = !!(profile.repairNeeded);
    const repairStartedAt = (profile.repairStartedAt as number) || 0;
    if (newFriction >= 8 && !repairNeeded) {
      repairNeeded = true;
      profile.repairStartedAt = Date.now();
    } else if (newFriction < 4 && repairNeeded) {
      repairNeeded = false;
      profile.repairStartedAt = 0;
    }

    // Persist
    const now = Date.now();
    const profileData = JSON.stringify({
      signals7d: signals,
      windowStats: window,
      lastUpgradeAt: profile.lastUpgradeAt || 0,
      repairStartedAt: repairNeeded ? (repairStartedAt || now) : 0,
    });

    db.prepare(`
      UPDATE relationship_profiles SET
        trust_level = ?, friction_score = ?, repair_needed = ?,
        autonomy_budget = ?, profile_data = ?, updated_at = ?
      WHERE user_id = ? AND project_id = ?
    `).run(
      profile.trustLevel, newFriction, repairNeeded ? 1 : 0,
      newAutonomy, profileData, now, userId, projectId,
    );

    return this.getRelationshipProfile(projectId, userId);
  }

  /** Daily signal decay: ×0.85 on all 7d counters */
  decayRelationshipSignals(projectId: string): number {
    const db = getDb();
    const rows = db.prepare(
      "SELECT user_id, project_id, profile_data FROM relationship_profiles WHERE project_id = ?"
    ).all(projectId) as Array<{ user_id: string; project_id: string; profile_data: string }>;

    let updated = 0;
    for (const row of rows) {
      const data = JSON.parse(row.profile_data || "{}");
      const signals = data.signals7d || {};
      for (const k of ["correction", "frustration", "urgency", "confirmation"]) {
        signals[k] = Math.round((signals[k] || 0) * 0.85 * 100) / 100;
      }
      data.signals7d = signals;
      db.prepare(
        "UPDATE relationship_profiles SET profile_data = ?, updated_at = ? WHERE user_id = ? AND project_id = ?"
      ).run(JSON.stringify(data), Date.now(), row.user_id, row.project_id);
      updated++;
    }
    return updated;
  }

  /** Evaluate trustLevel upgrade/downgrade based on sliding window */
  evaluateTrustLevel(projectId: string, userId: string = "default"): { oldLevel: string; newLevel: string; changed: boolean } {
    const db = getDb();
    const profile = this.getRelationshipProfile(projectId, userId) as Record<string, unknown>;
    const oldLevel = profile.trustLevel as string;
    const window = (profile.windowStats as Record<string, number>) || {};
    const friction = profile.frictionScore as number;
    const repairNeeded = !!(profile.repairNeeded);
    const lastUpgradeAt = (profile.lastUpgradeAt as number) || 0;
    const now = Date.now();

    // Downgrade checks (highest priority)
    if (repairNeeded && (now - ((profile.repairStartedAt as number) || now)) > 48 * 60 * 60 * 1000) {
      const newLevel = oldLevel === "L3" ? "L2" : "L1";
      if (newLevel !== oldLevel) {
        db.prepare("UPDATE relationship_profiles SET trust_level = ?, updated_at = ? WHERE user_id = ? AND project_id = ?").run(newLevel, now, userId, projectId);
        return { oldLevel, newLevel, changed: true };
      }
    }

    // High-severity errors → immediate L1
    if ((window.highSeverityErrors || 0) > 0 && oldLevel !== "L1") {
      db.prepare("UPDATE relationship_profiles SET trust_level = 'L1', updated_at = ? WHERE user_id = ? AND project_id = ?").run(now, userId, projectId);
      return { oldLevel, newLevel: "L1", changed: true };
    }

    // 2 consecutive high-severity corrections in window → drop one level
    if ((window.highSeverityErrors || 0) >= 2 && oldLevel !== "L1") {
      const newLevel = oldLevel === "L3" ? "L2" : "L1";
      db.prepare("UPDATE relationship_profiles SET trust_level = ?, updated_at = ? WHERE user_id = ? AND project_id = ?").run(newLevel, now, userId, projectId);
      return { oldLevel, newLevel, changed: true };
    }

    // Upgrade cooldown: 7 days
    if (now - lastUpgradeAt < 7 * 24 * 60 * 60 * 1000) {
      return { oldLevel, newLevel: oldLevel, changed: false };
    }

    const total = window.totalInteractions || 0;
    const accepted = window.acceptedAutonomy || 0;
    const corrections = window.correctionCount || 0;
    const correctionRate = total > 0 ? corrections / total : 1;

    // L1 → L2 (14-day window criteria simplified: since we don't track per-day,
    // we rely on the accumulated window stats which get reset on upgrade)
    if (oldLevel === "L1" && accepted >= 5 && correctionRate < 0.2 && friction < 6 && !repairNeeded) {
      db.prepare("UPDATE relationship_profiles SET trust_level = 'L2', updated_at = ? WHERE user_id = ? AND project_id = ?").run(now, userId, projectId);
      this._resetWindowStats(projectId, userId);
      return { oldLevel, newLevel: "L2", changed: true };
    }

    // L2 → L3
    if (oldLevel === "L2" && accepted >= 15 && correctionRate < 0.1 && (window.highSeverityErrors || 0) === 0 && !repairNeeded) {
      db.prepare("UPDATE relationship_profiles SET trust_level = 'L3', updated_at = ? WHERE user_id = ? AND project_id = ?").run(now, userId, projectId);
      this._resetWindowStats(projectId, userId);
      return { oldLevel, newLevel: "L3", changed: true };
    }

    return { oldLevel, newLevel: oldLevel, changed: false };
  }

  private _resetWindowStats(projectId: string, userId: string): void {
    const db = getDb();
    const row = db.prepare("SELECT profile_data FROM relationship_profiles WHERE user_id = ? AND project_id = ?").get(userId, projectId) as { profile_data: string } | undefined;
    if (!row) return;
    const data = JSON.parse(row.profile_data || "{}");
    data.windowStats = { totalInteractions: 0, acceptedAutonomy: 0, correctionCount: 0, highSeverityErrors: 0 };
    data.lastUpgradeAt = Date.now();
    db.prepare("UPDATE relationship_profiles SET profile_data = ? WHERE user_id = ? AND project_id = ?").run(JSON.stringify(data), userId, projectId);
  }

  getConstitutionalFragments(projectId: string): Array<{ fragmentId: string; label: string; weight: number }> {
    const db = getDb();
    return db.prepare(`
      SELECT fa.fragment_id as fragmentId, fa.label, fa.weight
      FROM fragment_anchors fa
      JOIN fragments f ON f.id = fa.fragment_id
      WHERE fa.channel = 'FEEL' AND fa.weight >= ${CONSTITUTIONAL_WEIGHT_THRESHOLD} AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted' AND f.project_id = ?
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
      const byteLen = Math.min(blob.length, 1536 * 4);
      const floats = new Float32Array(blob.buffer, blob.byteOffset, byteLen / 4);
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

  // ── Memory Repair Loop v1 ──────────────────────────

  repairMemory(projectId: string): {
    zeroHitAliases: number;
    downweighted: number;
    jobsCreated: number;
  } {
    const db = getDb();
    let zeroHitAliases = 0;
    let downweighted = 0;
    let jobsCreated = 0;

    // 1. Scan recent zero-hit queries (last 7 days)
    const zeroHitQueries = db.prepare(`
      SELECT DISTINCT query FROM query_events
      WHERE project_id = ? AND result_count = 0 AND searched_at > ?
      ORDER BY searched_at DESC LIMIT 20
    `).all(projectId, Date.now() - 7 * 24 * 60 * 60 * 1000) as Array<{ query: string }>;

    for (const zq of zeroHitQueries) {
      // Extract clean keywords from the query
      const cleaned = zq.query.replace(/[，。！？、；：""''（）\s]+/g, "");
      const bigrams: string[] = [];
      for (let i = 0; i < cleaned.length - 1; i++) {
        const pair = cleaned.slice(i, i + 2);
        if (/[一-鿿]/.test(pair[0]!) && /[一-鿿]/.test(pair[1]!)) {
          bigrams.push(pair);
        }
      }
      if (bigrams.length === 0) continue;

      const likeClauses = bigrams.slice(0, 6).map(() => "summary LIKE ?").join(" OR ");
      const likeParams = bigrams.slice(0, 6).map((bg) => `%${bg}%`);

      const candidates = db.prepare(`
        SELECT id, summary FROM fragments
        WHERE project_id = ? AND retrieval_state IN ('active','warm') AND asset_state != 'user_deleted'
          AND (${likeClauses})
        LIMIT 10
      `).all(projectId, ...likeParams) as Array<{ id: string; summary: string }>;

      if (candidates.length >= 2) {
        // Create aliases between the highest-scoring pair of candidates
        const best = candidates[0]!;
        const second = candidates[1]!;
        const canonical = best.summary.slice(0, 30);
        const alias = second.summary.slice(0, 30);

        if (canonical !== alias) {
          db.prepare(`
            INSERT OR IGNORE INTO aliases (id, project_id, canonical, alias, source, confidence, created_at)
            VALUES (?, ?, ?, ?, 'auto', 0.7, ?)
          `).run(
            `alias-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            projectId, canonical, alias, Date.now()
          );
          zeroHitAliases++;

          db.prepare(`
            INSERT INTO memory_repair_jobs (id, project_id, job_type, trigger, fragments_affected, action_taken, created_at)
            VALUES (?, ?, 'auto_alias', ?, ?, ?, ?)
          `).run(
            `mrj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            projectId,
            `zero-hit query: ${zq.query.slice(0, 80)}`,
            JSON.stringify([best.id, second.id]),
            `created alias: "${canonical}" ↔ "${alias}"`,
            Date.now(),
          );
          jobsCreated++;
        }
      }
    }

    // 2. Downweight low-hit fragments: recalled_count < 2, age > 30 days, retrieval_state = 'active'
    const lowHitFrags = db.prepare(`
      SELECT id FROM fragments
      WHERE project_id = ? AND recalled_count < 2 AND retrieval_state = 'active' AND asset_state != 'user_deleted'
        AND created_at < ?
      LIMIT 10
    `).all(projectId, Date.now() - 30 * 24 * 60 * 60 * 1000) as Array<{ id: string }>;

    if (lowHitFrags.length > 0) {
      const updateStmt = db.prepare(`UPDATE fragments SET retrieval_state = 'warm', decay_score = 0.5 WHERE id = ?`);
      for (const f of lowHitFrags) {
        updateStmt.run(f.id);
        downweighted++;
      }

      db.prepare(`
        INSERT INTO memory_repair_jobs (id, project_id, job_type, trigger, fragments_affected, action_taken, created_at)
        VALUES (?, ?, 'weight_adjust', ?, ?, ?, ?)
      `).run(
        `mrj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        `low recall count (< 2) + age > 30 days`,
        JSON.stringify(lowHitFrags.map((f) => f.id)),
        `downweighted ${lowHitFrags.length} fragments: active → warm, decay_score = 0.5`,
        Date.now(),
      );
      jobsCreated++;
    }

    return { zeroHitAliases, downweighted, jobsCreated };
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
