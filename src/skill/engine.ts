import type { FragmentationInput, Fragment, AliasEntry } from "../types.js";
import { getDb } from "../db/connection.js";
import { persistFragments, deleteFragment } from "../db/repository.js";
import { fragmentTranscript, type FragmentResult } from "../core/fragmenter.js";
import { computeDecayScore, CONSTITUTIONAL_WEIGHT_THRESHOLD, noveltyFactor, calcSystemAgeDays, applyNovelty } from "../core/decay.js";
import { updateActiveContext as updateActiveContextImpl } from "../core/active-context.js";
import { Embedder, setCurrentEmbedder, cosineSimilarity } from "../core/embedder.js";

export interface EngineConfig {
  apiKey: string;
  fragmentationKey?: string;
  fragmentationBaseURL?: string;
  /** Embedding model name (e.g. bge-m3, text-embedding-3-small). Falls back to AGENTMEMORY_EMBEDDING_MODEL env var. */
  embeddingModel?: string;
  /** Fragmentation LLM model name (e.g. MiniMax-M2.7, deepseek-v4-pro). Falls back to auto-detect from fragmentationBaseURL. */
  fragmentationModel?: string;
  baseURL?: string;
}

import { checkpointWAL } from "../db/connection.js";

export class MemoryEngine {
  public readonly embedder: Embedder;

  constructor(private config: EngineConfig) {
    this.embedder = new Embedder(config.apiKey, config.baseURL, config.embeddingModel);
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

  runDecay(options?: { protectConstitutional?: boolean; projectId?: string }): { warmed: number; archived: number; cooled: number } {
    const protectConstitutional = options?.protectConstitutional ?? false;
    const projectId = options?.projectId;
    const db = getDb();

    // Compute novelty-adjusted decay thresholds
    let nf = 0;
    if (projectId) {
      const firstRow = db.prepare(
        "SELECT MIN(created_at) as first FROM fragments WHERE project_id = ?"
      ).get(projectId) as { first: number | null } | undefined;
      const ageDays = calcSystemAgeDays(firstRow?.first ?? null);
      nf = noveltyFactor(ageDays);
    }

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

        const decay = computeDecayScore(createdAt, lastRecalledAt, recalledCount, anchorWeight, nf);
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

  async runDistillation(projectId: string, options?: { minFeelScore?: number; minMembers?: number; minSessions?: number }): Promise<number> {
    const db = getDb();

    // Novelty-adjusted thresholds: young systems are more aggressive
    let nf = 0;
    const firstRow = db.prepare(
      "SELECT MIN(created_at) as first FROM fragments WHERE project_id = ?"
    ).get(projectId) as { first: number | null } | undefined;
    const ageDays = calcSystemAgeDays(firstRow?.first ?? null);
    nf = noveltyFactor(ageDays);

    const minFeelScore = options?.minFeelScore ?? (nf > 0 ? Math.round(60 * (1 - nf * 0.7)) : 60);
    const minMembers = options?.minMembers ?? applyNovelty(5, nf, 0.8);
    const minSessions = options?.minSessions ?? (nf > 0.5 ? 1 : 2);

    // Load fragments with primary channel = highest-weight anchor (not lexicographic MIN).
    const fragments = db.prepare(`
      SELECT f.id, f.summary, f.session_id,
             (SELECT fa2.channel FROM fragment_anchors fa2
              WHERE fa2.fragment_id = f.id
              ORDER BY fa2.weight DESC, fa2.channel LIMIT 1) as channel,
             (SELECT fa2.label FROM fragment_anchors fa2
              WHERE fa2.fragment_id = f.id
              ORDER BY fa2.weight DESC, fa2.label LIMIT 1) as label,
             GROUP_CONCAT(DISTINCT fa.channel) as all_channels,
             MAX(CASE WHEN fa.channel = 'FEEL' THEN fa.weight ELSE NULL END) as max_feel,
             MAX(CASE WHEN fa.channel = 'FEEL' AND fa.weight >= 80 THEN 1 ELSE 0 END) as is_constitutional
      FROM fragments f
      JOIN fragment_anchors fa ON fa.fragment_id = f.id
      WHERE f.project_id = ? AND f.retrieval_state IN ('active', 'warm', 'archived') AND f.asset_state != 'user_deleted'
      GROUP BY f.id, f.summary
    `).all(projectId) as Array<{ id: string; summary: string; session_id: string; label: string; channel: string; all_channels: string; max_feel: number | null; is_constitutional: number }>;

    const groups = new Map<string, Array<{ id: string; summary: string; sessionId: string; label: string; channel: string; allChannels: string; maxFeel: number | null; isConstitutional: boolean }>>();
    for (const f of fragments) {
      const key = `${f.channel}:${(f.label || f.summary).slice(0, 50)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({
        id: f.id, summary: f.summary, sessionId: f.session_id, label: f.label, channel: f.channel,
        allChannels: f.all_channels, maxFeel: f.max_feel, isConstitutional: f.is_constitutional === 1,
      });
    }

    let distilled = 0;
    for (const [groupKey, members] of groups) {
      if (members.length < minMembers) continue;

      // Cross-session gate: rules must span ≥2 distinct sessions to be general
      const distinctSessions = new Set(members.map(m => m.sessionId).filter(Boolean));
      if (distinctSessions.size < minSessions) continue;

      // Quality gate: if any member has FEEL signal, average must meet threshold.
      const feelScores = members.map(m => m.maxFeel).filter((s): s is number => s !== null);
      let avgFeel = 50;
      if (feelScores.length > 0) {
        avgFeel = feelScores.reduce((a, b) => a + b, 0) / feelScores.length;
        if (avgFeel < minFeelScore) continue;
      }

      // Filter system noise before scoring — prevents noise fragments from inflating
      // group size, session spread, and channel diversity factors.
      const NOISE_RE = /<local-command|\[AgentMemory\]|hook failed|spawn.*ENOENT/;
      const cleanMembers = members.filter(m => !NOISE_RE.test(m.summary) && !NOISE_RE.test(m.label));
      const effectiveMembers = cleanMembers.length >= minMembers ? cleanMembers : members;

      const exemplar = effectiveMembers[0] ?? members[0];
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

      // Rule text from cleanest, most representative member
      const best = effectiveMembers.reduce((a, b) =>
        ((a.maxFeel ?? 0) + a.summary.length * 0.01) > ((b.maxFeel ?? 0) + b.summary.length * 0.01) ? a : b
      );
      let ruleText = best!.summary.slice(0, 120);

      // Multi-factor weight scoring.
      const hasConstitutional = effectiveMembers.some(m => m.isConstitutional);
      const uniqueChannels = new Set<string>();
      for (const m of effectiveMembers) {
        for (const ch of m.allChannels.split(",")) {
          if (ch) uniqueChannels.add(ch);
        }
      }
      const effectiveSessions = new Set(effectiveMembers.map(m => m.sessionId).filter(Boolean));

      // WHO bonus — only when the group's primary channel is WHO (identity-centric).
      // "Mixed" groups that happen to mention a person don't qualify.
      const isWhoGroup = exemplar?.channel === "WHO";

      let ruleWeight = 0.18; // base — low enough that single-session file refs stay marginal

      // Session spread — diminishing returns (cap 1.5x)
      if (effectiveSessions.size >= 5) ruleWeight *= 1.5;
      else if (effectiveSessions.size >= 3) ruleWeight *= 1.3;
      else if (effectiveSessions.size >= 2) ruleWeight *= 1.15;

      // Group size — more evidence (max 1.4x)
      if (effectiveMembers.length >= 10) ruleWeight *= 1.4;
      else if (effectiveMembers.length >= 8) ruleWeight *= 1.25;
      else if (effectiveMembers.length >= 5) ruleWeight *= 1.1;

      // Channel diversity — cross-channel patterns are richer (max 1.4x)
      if (uniqueChannels.size >= 3) ruleWeight *= 1.4;
      else if (uniqueChannels.size >= 2) ruleWeight *= 1.2;

      // WHO bonus — identity rules are inherently valuable, rare, and hard to recover
      if (isWhoGroup) ruleWeight *= 1.4;

      // Constitutional bonus
      if (hasConstitutional) ruleWeight *= 1.5;

      // FEEL intensity
      if (feelScores.length > 0) {
        const af = feelScores.reduce((a, b) => a + b, 0) / feelScores.length;
        if (af >= 70) ruleWeight *= 1.3;
        else if (af >= 50) ruleWeight *= 1.1;
      }

      ruleWeight = Math.min(2.0, Math.round(ruleWeight * 100) / 100);

      const ruleId = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Embed rule text for future vector-based dedup
      let ruleVec: Buffer | null = null;
      try { const v = await this.embedder.embed(ruleText, "store"); ruleVec = Buffer.from(new Float32Array(v).buffer); } catch {}
      db.prepare(`INSERT OR IGNORE INTO distilled_rules (id, fingerprint, text, weight, priority, vector, created_at) VALUES (?, ?, ?, ?, 50, ?, ?)`).run(
        ruleId, fingerprint, ruleText, ruleWeight, ruleVec, Date.now()
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

  /** Step 2b: Single-event distillation — high-value signals (correction, decision) that
   *  don't need cross-session repetition to be worth distilling.
   *  Uses vector similarity for dedup, creates priority=25 rules.
   *  Also handles probation downgrade for unused priority=25 rules. */
  async distillSingleEventRules(projectId: string): Promise<number> {
    const db = getDb();
    const NOW = Date.now();

    // Probation downgrade: priority=25 rules unused for 30 days → demote to 50
    const downgraded = db.prepare(`
      UPDATE distilled_rules SET priority = 50 WHERE priority = 25
      AND created_at < ?
      AND id NOT IN (
        SELECT DISTINCT dr.id FROM distilled_rules dr
        JOIN rule_sources rs ON rs.rule_id = dr.id
        JOIN fragments f ON f.id = rs.fragment_id
        WHERE f.last_recalled_at > ?
      )
    `).run(NOW - 30 * 24 * 60 * 60 * 1000, NOW - 30 * 24 * 60 * 60 * 1000);
    if (downgraded.changes > 0) {
      console.error(`[AgentMemory] 教训规则试用期降级: ${downgraded.changes} 条`);
    }

    // Load unconsumed high-weight signals ordered by weight
    const signals = db.prepare(`
      SELECT ls.id, ls.session_id, ls.signal_type, ls.label, ls.weight
      FROM lightweight_signals ls
      WHERE ls.project_id = ? AND ls.consumed = 0
        AND ls.signal_type IN ('correction','decision','frustration','self_reflect')
        AND ls.weight >= 25
      ORDER BY ls.weight DESC, ls.created_at ASC
      LIMIT 50
    `).all(projectId) as Array<{ id: string; session_id: string; signal_type: string; label: string; weight: number }>;

    if (signals.length === 0) return 0;

    // Batch-embed existing rule texts for dedup (cosine > 0.80 = duplicate)
    const existingRules = db.prepare(`
      SELECT id, text, vector FROM distilled_rules WHERE vector IS NOT NULL
    `).all() as Array<{ id: string; text: string; vector: Buffer | null }>;

    let distilled = 0;

    for (const sig of signals) {
      // Find fragments from this signal's session
      const frags = db.prepare(`
        SELECT f.id, f.summary, f.vector,
               (SELECT fa.label FROM fragment_anchors fa
                WHERE fa.fragment_id = f.id AND fa.channel = 'WHAT'
                ORDER BY fa.weight DESC LIMIT 1) as what_label
        FROM fragments f
        WHERE f.project_id = ? AND f.session_id = ? AND f.retrieval_state IN ('active','warm')
        ORDER BY f.created_at DESC LIMIT 3
      `).all(projectId, sig.session_id) as Array<{ id: string; summary: string; vector: Buffer | null; what_label: string | null }>;

      if (frags.length === 0) {
        // Signal consumed even if no fragments found (stale signal)
        db.prepare(`UPDATE lightweight_signals SET consumed = 1 WHERE id = ?`).run(sig.id);
        continue;
      }

      const exemplarText = frags[0]!.what_label || frags[0]!.summary.slice(0, 80);
      const channel = sig.signal_type === "correction" ? "FEEL" : "WHAT";
      const fingerprint = `${projectId}::${channel}::${exemplarText.trim().toLowerCase().slice(0, 50)}`;

      // Dedup check: vector similarity against existing rules
      let isDuplicate = false;
      let existingRuleId: string | null = null;

      try {
        let queryVec: number[];
        const cachedVec = frags.find(f => f.vector && f.vector.length >= 4);
        if (cachedVec?.vector) {
          queryVec = Array.from(new Float32Array(cachedVec.vector.buffer, cachedVec.vector.byteOffset, cachedVec.vector.length / 4));
        } else {
          queryVec = await this.embedder.embed(exemplarText, "store");
        }

        for (const rule of existingRules) {
          if (!rule.vector || rule.vector.length < 4) continue;
          const ruleVec = Array.from(new Float32Array(rule.vector.buffer, rule.vector.byteOffset, rule.vector.length / 4));
          if (cosineSimilarity(queryVec, ruleVec) > 0.80) {
            isDuplicate = true;
            existingRuleId = rule.id;
            break;
          }
        }
      } catch { /* embed failed — skip dedup, create new rule */ }

      if (isDuplicate && existingRuleId) {
        // Existing rule matched: add rule_source links for these fragments
        for (const f of frags) {
          db.prepare(`INSERT OR IGNORE INTO rule_sources (rule_id, fragment_id, project_id) VALUES (?, ?, ?)`).run(
            existingRuleId, f.id, projectId
          );
        }
        // Boost weight slightly
        db.prepare(`UPDATE distilled_rules SET weight = MIN(2.0, weight * 1.1) WHERE id = ?`).run(existingRuleId);
      } else {
        // New lesson rule — embed for future vector dedup
        const ruleId = `rl-${NOW}-${Math.random().toString(36).slice(2, 6)}`;
        const ruleWeight = Math.min(1.5, 0.5 + sig.weight * 0.01);
        let ruleVec: Buffer | null = null;
        try { const v = await this.embedder.embed(exemplarText, "store"); ruleVec = Buffer.from(new Float32Array(v).buffer); } catch {}

        db.prepare(`
          INSERT OR IGNORE INTO distilled_rules (id, fingerprint, text, weight, priority, vector, created_at)
          VALUES (?, ?, ?, ?, 25, ?, ?)
        `).run(ruleId, fingerprint, exemplarText.slice(0, 120), ruleWeight, ruleVec, NOW);

        for (const f of frags) {
          db.prepare(`INSERT OR IGNORE INTO rule_sources (rule_id, fragment_id, project_id) VALUES (?, ?, ?)`).run(
            ruleId, f.id, projectId
          );
        }
        distilled++;
      }

      // Mark signal consumed
      db.prepare(`UPDATE lightweight_signals SET consumed = 1 WHERE id = ?`).run(sig.id);
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
      // Constitutional fragments (weight ≥ 80) represent distilled rules,
      // not user emotional feedback. Skip friction penalties but still track
      // for rule deprecation counting.
      if (isHighSeverity) {
        signals.constitutional_correction = (signals.constitutional_correction || 0) + 1;
        frictionDelta = 0;
        autonomyDelta = 0;
        window.correctionCount = (window.correctionCount || 0) + 1;
      } else {
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

  /** Daily signal decay: ×0.85 on signals, ×0.9 on friction, + repair auto-resolution */
  decayRelationshipSignals(projectId: string): number {
    const db = getDb();
    const rows = db.prepare(
      "SELECT user_id, project_id, friction_score, repair_needed, profile_data FROM relationship_profiles WHERE project_id = ?"
    ).all(projectId) as Array<{ user_id: string; project_id: string; friction_score: number; repair_needed: number; profile_data: string }>;

    const now = Date.now();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    let updated = 0;
    for (const row of rows) {
      const data = JSON.parse(row.profile_data || "{}");
      const signals = data.signals7d || {};
      for (const k of ["correction", "frustration", "urgency", "confirmation"]) {
        signals[k] = Math.round((signals[k] || 0) * 0.85 * 100) / 100;
      }
      data.signals7d = signals;

      // FrictionScore natural decay: ×0.9 per dreaming cycle
      const newFriction = Math.max(0, Math.round(row.friction_score * 0.9 * 100) / 100);

      // Repair auto-resolution: clear after 7 days without new high-severity errors
      let newRepairNeeded = !!(row.repair_needed);
      const repairStartedAt = (data.repairStartedAt as number) || 0;
      if (newRepairNeeded && repairStartedAt > 0 && (now - repairStartedAt) > SEVEN_DAYS) {
        newRepairNeeded = false;
        data.repairStartedAt = 0;
      }

      db.prepare(
        "UPDATE relationship_profiles SET friction_score = ?, repair_needed = ?, profile_data = ?, updated_at = ? WHERE user_id = ? AND project_id = ?"
      ).run(newFriction, newRepairNeeded ? 1 : 0, JSON.stringify(data), now, row.user_id, row.project_id);
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

  // ── P0 Active Cycle ─────────────────────────────

  /** Detect contradictory fragments: semantically similar but with opposing stances */
  async detectContradictions(projectId: string): Promise<Array<{
    fragmentA: { id: string; summary: string; feelLabel: string };
    fragmentB: { id: string; summary: string; feelLabel: string };
    similarity: number;
    sharedTopics: string[];
    conflictingTerms: { assertive: string[]; cautious: string[] };
    riskLevel: "low" | "medium" | "high";
  }>> {
    const db = getDb();
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const fragments = db.prepare(`
      SELECT f.id, f.summary, f.vector,
        (SELECT fa.label FROM fragment_anchors fa WHERE fa.fragment_id = f.id AND fa.channel = 'FEEL' ORDER BY fa.weight DESC LIMIT 1) as feelLabel
      FROM fragments f
      WHERE f.project_id = ? AND f.retrieval_state IN ('active','warm') AND f.asset_state != 'user_deleted'
        AND f.created_at > ? AND f.vector IS NOT NULL
      LIMIT 500
    `).all(projectId, ninetyDaysAgo) as Array<{ id: string; summary: string; vector: Buffer; feelLabel: string | null }>;

    const withFeel = fragments.filter(f => f.feelLabel);
    if (withFeel.length < 20) return [];

    const ASSERTIVE_KW = /直接|动手|自己做|不确认|自动|立刻|主动|自行|不用|不要问/;
    const CAUTIOUS_KW = /讨论|确认|先问|等待|审查|谨慎|商量|征求|先讨论|不要直接/;

    const assertive = withFeel.filter(f => ASSERTIVE_KW.test(f.summary));
    const cautious = withFeel.filter(f => CAUTIOUS_KW.test(f.summary));
    if (assertive.length === 0 || cautious.length === 0) return [];

    const results: Array<{
      fragmentA: { id: string; summary: string; feelLabel: string };
      fragmentB: { id: string; summary: string; feelLabel: string };
      similarity: number;
      sharedTopics: string[];
      conflictingTerms: { assertive: string[]; cautious: string[] };
      riskLevel: "low" | "medium" | "high";
    }> = [];

    // Extract topic bigrams that are NOT stance keywords
    const ALL_STANCE = /直接|动手|自己做|不确认|自动|立刻|主动|自行|不用|不要问|讨论|确认|先问|等待|审查|谨慎|商量|征求|先讨论|不要直接/;
    function getTopics(text: string): Set<string> {
      const bigrams = new Set<string>();
      for (let i = 0; i < text.length - 1; i++) {
        const bg = text.slice(i, i + 2);
        if (/[一-鿿]/.test(bg[0]!) && /[一-鿿]/.test(bg[1]!) && !ALL_STANCE.test(bg)) {
          bigrams.add(bg);
        }
      }
      return bigrams;
    }

    for (const a of assertive.slice(0, 30)) {
      if (!a.vector || a.vector.length < 4) continue;
      const aVec = Array.from(new Float32Array(a.vector.buffer, a.vector.byteOffset, a.vector.length / 4));
      const aTopics = getTopics(a.summary);

      for (const c of cautious.slice(0, 30)) {
        if (a.id === c.id) continue;
        if (!c.vector || c.vector.length < 4) continue;
        const cVec = Array.from(new Float32Array(c.vector.buffer, c.vector.byteOffset, c.vector.length / 4));
        const sim = cosineSimilarity(aVec, cVec);
        if (sim < 0.70) continue;

        const cTopics = getTopics(c.summary);
        const shared = [...aTopics].filter(t => cTopics.has(t));
        if (shared.length < 2) continue;

        const aTerms = (a.feelLabel || "").match(ASSERTIVE_KW) || [];
        const cTerms = (c.feelLabel || "").match(CAUTIOUS_KW) || [];

        let riskLevel: "low" | "medium" | "high" = "low";
        if (sim > 0.85 && [...aTerms, ...cTerms].length >= 3) riskLevel = "high";
        else if (sim > 0.75 && [...aTerms, ...cTerms].length >= 2) riskLevel = "medium";

        results.push({
          fragmentA: { id: a.id, summary: a.summary.slice(0, 80), feelLabel: a.feelLabel! },
          fragmentB: { id: c.id, summary: c.summary.slice(0, 80), feelLabel: c.feelLabel! },
          similarity: Math.round(sim * 100) / 100,
          sharedTopics: shared.slice(0, 5),
          conflictingTerms: { assertive: [...new Set(aTerms)], cautious: [...new Set(cTerms)] },
          riskLevel,
        });

        if (results.length >= 20) break;
      }
      if (results.length >= 20) break;
    }

    return results.sort((a, b) => (b.riskLevel === "high" ? 3 : b.riskLevel === "medium" ? 2 : 1) - (a.riskLevel === "high" ? 3 : a.riskLevel === "medium" ? 2 : 1));
  }

  /** Pattern insight: topic clusters and trend detection across 14-day windows */
  detectPatterns(projectId: string): {
    topClusters: Array<{ label: string; channel: string; count: number; avgWeight: number }>;
    risingTrends: Array<{ label: string; channel: string; currentCount: number; previousCount: number; growthRate: number }>;
    channelShift: Array<{ channel: string; currentPct: number; previousPct: number; delta: number }> | null;
  } {
    const db = getDb();
    const now = Date.now();
    const windowMs = 14 * 24 * 60 * 60 * 1000;

    function clusterWindow(since: number): Map<string, { channel: string; count: number; totalWeight: number }> {
      const rows = db.prepare(`
        SELECT MIN(fa.label) as label, MIN(fa.channel) as channel, COUNT(*) as cnt, SUM(fa.weight) as totalWeight
        FROM fragments f
        JOIN fragment_anchors fa ON fa.fragment_id = f.id
        WHERE f.project_id = ? AND f.created_at > ? AND f.asset_state != 'user_deleted'
        GROUP BY fa.channel, SUBSTR(fa.label, 1, 30)
        ORDER BY cnt DESC
      `).all(projectId, since) as Array<{ label: string; channel: string; cnt: number; totalWeight: number }>;
      const map = new Map<string, { channel: string; count: number; totalWeight: number }>();
      for (const r of rows) {
        map.set(`${r.channel}:${r.label}`, { channel: r.channel, count: r.cnt, totalWeight: r.totalWeight });
      }
      return map;
    }

    const current = clusterWindow(now - windowMs);
    const previous = clusterWindow(now - 2 * windowMs);

    const topClusters = [...current.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([key, v]) => ({ label: key.split(":").slice(1).join(":"), channel: v.channel, count: v.count, avgWeight: Math.round(v.totalWeight / v.count) }));

    const risingTrends: Array<{ label: string; channel: string; currentCount: number; previousCount: number; growthRate: number }> = [];
    for (const [key, v] of current) {
      const prev = previous.get(key);
      const prevCount = prev?.count ?? 0;
      if (v.count >= 3 && prevCount > 0 && v.count / prevCount >= 2.0) {
        risingTrends.push({ label: key.split(":").slice(1).join(":"), channel: v.channel, currentCount: v.count, previousCount: prevCount, growthRate: Math.round(v.count / prevCount * 10) / 10 });
      }
    }

    // Channel distribution shift
    function channelPct(map: Map<string, { channel: string; count: number }>) {
      const totals: Record<string, number> = {};
      for (const [, v] of map) totals[v.channel] = (totals[v.channel] || 0) + v.count;
      const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
      return { totals, sum };
    }
    const currDist = channelPct(current);
    const prevDist = channelPct(previous);
    const shift: Array<{ channel: string; currentPct: number; previousPct: number; delta: number }> = [];
    for (const ch of ["WHAT", "FEEL", "WHO", "WHERE"]) {
      const cp = Math.round((currDist.totals[ch] || 0) / currDist.sum * 100);
      const pp = Math.round((prevDist.totals[ch] || 0) / prevDist.sum * 100);
      if (Math.abs(cp - pp) > 20) shift.push({ channel: ch, currentPct: cp, previousPct: pp, delta: cp - pp });
    }

    return { topClusters, risingTrends, channelShift: shift.length > 0 ? shift : null };
  }

  /** Memory self-check: fragment health, channel balance, zero-hit ratio */
  runSelfCheck(projectId: string): {
    fragmentCounts: { total: number; active: number; archived: number; cold: number };
    channelDistribution: Record<string, number>;
    zeroHitFragments: number;
    coldFragmentRatio: number;
    pendingFragmentation: number;
    lastDreamingAt: number | null;
    alerts: Array<{ type: string; severity: "warning" | "critical"; message: string }>;
  } {
    const db = getDb();

    const counts = db.prepare(`
      SELECT retrieval_state, COUNT(*) as cnt FROM fragments
      WHERE project_id = ? AND asset_state != 'user_deleted'
      GROUP BY retrieval_state
    `).all(projectId) as Array<{ retrieval_state: string; cnt: number }>;
    const countMap: Record<string, number> = {};
    for (const c of counts) countMap[c.retrieval_state] = c.cnt;
    const total = Object.values(countMap).reduce((a, b) => a + b, 0);
    const active = (countMap.active || 0) + (countMap.warm || 0);

    // Channel distribution
    const channels = db.prepare(`
      SELECT fa.channel, COUNT(DISTINCT f.id) as cnt
      FROM fragments f
      JOIN fragment_anchors fa ON fa.fragment_id = f.id
      WHERE f.project_id = ? AND f.asset_state != 'user_deleted'
      GROUP BY fa.channel
    `).all(projectId) as Array<{ channel: string; cnt: number }>;
    const chDist: Record<string, number> = {};
    let chTotal = 0;
    for (const ch of channels) { chDist[ch.channel] = ch.cnt; chTotal += ch.cnt; }
    for (const k of Object.keys(chDist)) chDist[k] = Math.round(chDist[k]! / chTotal * 100);

    // Zero-hit: fragments never recalled, > 30 days old
    const zeroHit = db.prepare(`
      SELECT COUNT(*) as cnt FROM fragments
      WHERE project_id = ? AND recalled_count = 0 AND created_at < ? AND asset_state != 'user_deleted'
    `).get(projectId, Date.now() - 30 * 24 * 60 * 60 * 1000) as { cnt: number };

    const coldRatio = active > 0 ? zeroHit.cnt / active : 0;

    const pending = db.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ? AND pending_fragmentation > 0"
    ).get(projectId) as { cnt: number };

    const project = db.prepare("SELECT last_dreaming_at FROM projects WHERE id = ?").get(projectId) as { last_dreaming_at: number | null } | undefined;
    const lastDreamingAt = project?.last_dreaming_at ?? null;

    const alerts: Array<{ type: string; severity: "warning" | "critical"; message: string }> = [];
    if (coldRatio > 0.3) alerts.push({ type: "cold_ratio", severity: "critical", message: `${Math.round(coldRatio * 100)}% 的碎片从未被召回，记忆库可能是单向存储` });
    for (const ch of ["FEEL", "WHO", "WHERE"]) {
      if ((chDist[ch] || 0) < 10) alerts.push({ type: "channel_imbalance", severity: "warning", message: `${ch} 通道占比低于 10%，碎片化可能偏向单一维度` });
    }
    if (pending.cnt > 10) alerts.push({ type: "pending_backlog", severity: "warning", message: `${pending.cnt} 个 session 待碎片化` });
    if (lastDreamingAt && (Date.now() - lastDreamingAt) > 48 * 60 * 60 * 1000) {
      alerts.push({ type: "dreaming_stale", severity: "warning", message: "Dreaming 超过 48 小时未运行" });
    }

    return {
      fragmentCounts: { total, active, archived: countMap.archived || 0, cold: countMap.cold || 0 },
      channelDistribution: chDist,
      zeroHitFragments: zeroHit.cnt,
      coldFragmentRatio: Math.round(coldRatio * 1000) / 1000,
      pendingFragmentation: pending.cnt,
      lastDreamingAt,
      alerts,
    };
  }

  /** Proactive care: composite check using friction gate + time + recent signals */
  generateProactiveCare(projectId: string): {
    message: string;
    level: "suggestion" | "gentle_nudge" | "active_concern";
    triggers: string[];
    at: number;
  } | null {
    const db = getDb();

    const profile = db.prepare("SELECT * FROM trust_profile WHERE project_id = ?").get(projectId) as Record<string, unknown> | undefined;
    if (!profile) return null;
    const correct = (profile.correct_count as number) || 0;
    const wrong = (profile.wrong_count as number) || 0;
    if (correct + wrong < 5) return null;

    const relProfile = db.prepare("SELECT friction_score, trust_level FROM relationship_profiles WHERE project_id = ?").get(projectId) as { friction_score: number; trust_level: string } | undefined;
    const friction = relProfile?.friction_score ?? 0;
    if (friction >= 8) return null; // too tense — don't add noise

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentFeel = db.prepare(`
      SELECT fa.label, fa.weight FROM fragment_anchors fa
      JOIN fragments f ON f.id = fa.fragment_id
      WHERE f.project_id = ? AND fa.channel = 'FEEL' AND fa.weight >= 30 AND f.created_at > ?
      ORDER BY fa.weight DESC LIMIT 5
    `).all(projectId, oneDayAgo) as Array<{ label: string; weight: number }>;

    const hour = new Date().getHours();
    const isLateNight = hour >= 1 && hour <= 5;
    const negativeCount = recentFeel.filter(f => /纠正|不对|错了|错误|不要|不行|不好|不该|又|总是|一直|服了|烦/.test(f.label)).length;

    const frictionRate = correct + wrong > 0 ? wrong / (correct + wrong) : 0;
    const triggers: string[] = [];
    let level: "suggestion" | "gentle_nudge" | "active_concern" = "suggestion";

    if (isLateNight && frictionRate > 0.3) {
      triggers.push("late_night", "high_friction");
      level = "active_concern";
    } else if (frictionRate > 0.4 && negativeCount > 0) {
      triggers.push("high_friction", "negative_feel");
      level = "gentle_nudge";
    } else if (isLateNight) {
      triggers.push("late_night");
      level = "suggestion";
    } else {
      return null;
    }

    let message = "";
    if (level === "active_concern") {
      message = `凌晨 ${hour} 点了，今天已经纠正了我 ${wrong} 次。也许该停下来休息，明天再继续？`;
    } else if (level === "gentle_nudge") {
      message = `今天纠正频率偏高（${Math.round(frictionRate * 100)}%），需要我调整工作方式吗？`;
    } else {
      message = `已经是凌晨 ${hour} 点了，不早了。`;
    }

    return { message, level, triggers, at: Date.now() };
  }

  private async callFragmenter(input: FragmentationInput): Promise<FragmentResult> {
    const key = this.config.fragmentationKey || this.config.apiKey;
    if (!key || key === "test-key" || key.length <= 10) {
      return { output: { fragments: [], summary: "" }, usage: undefined };
    }
    const baseURL = this.config.fragmentationBaseURL || "https://api.deepseek.com";
    const model = this.config.fragmentationModel ?? "deepseek-v4-pro";
    return await fragmentTranscript(input, key, model, baseURL);
  }
}
