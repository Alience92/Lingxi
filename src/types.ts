export type Channel = "WHAT" | "FEEL" | "WHO" | "WHERE";
export type SignalSource = "behavior" | "clustering";

export interface FragmentAnchor {
  channel: Channel;
  label: string;
  weight: number;
  source: SignalSource;
  readonly timestamp: number;
}

export interface Fragment {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  anchors: FragmentAnchor[];
  linkedIds: string[];
  linkedCount: number;
  summary: string;
  decayScore: number;
  lastRecalledAt: number | null;
  recalledCount: number;
  readonly createdAt: number;
  retrievalState: "active" | "warm" | "archived" | "cold";
  assetState: "retained" | "exportable" | "user_deleted";
  distilledTo: string | undefined;
  subtype?: "decision" | "todo" | "preference" | null;
  scope?: string | null;
  keywords?: string | null;
  rawPrefix?: string | null;
}

export interface DistilledRule {
  readonly id: string;
  text: string;
  sourceFragmentIds: string[];
  weight: number;
  priority: number;
  projectIds: string[];
  readonly createdAt: number;
}

export interface SearchResult {
  fragment: Fragment;
  score: number;
  matchedAnchors: string[];
  missingLinks: number;
}

export interface SessionContext {
  sessionId: string;
  projectId: string;
  platform: "claude-code" | "openclaw" | "codex" | "generic";
  workspaceDir: string;
  lastMessages: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface FragmentationInput {
  transcript: string;
  sessionId: string;
  projectId: string;
}

export interface FragmentationOutput {
  fragments: Omit<Fragment, "decayScore" | "lastRecalledAt" | "recalledCount" | "retrievalState" | "assetState" | "distilledTo">[];
  summary: string;
}

export interface PrefetchResult {
  contextBlock: string;
  fragmentIds: string[];
  confidence: number;
}

export interface AliasEntry {
  readonly id: string;
  readonly projectId: string;
  canonical: string;
  alias: string;
  source: "manual" | "auto";
  confidence: number;
  readonly createdAt: number;
}

export interface InstallEstimate {
  fileCount: number;
  totalBytes: number;
  estimatedTokens: number;
  estimatedTimeMinutes: number;
  files: string[];
}

// ── Phase 2+ types (v4 architecture) ──────────────────────────────────

export interface ChallengeEvent {
  id: string;
  projectId: string;
  sessionId: string;
  level: 'L1' | 'L2' | 'L3';
  action: 'advise' | 'revise_required' | 'deliver_blocked';
  reasonType: 'preference_conflict' | 'decision_conflict' | 'constitutional_conflict';
  evidenceIds: string;
  evidenceSummary: string;
  llmResponseId?: string;
  confidence: number;
  resolved: number;
  userAccepted?: number | null;
  createdAt: number;
}

export interface RuleApplicationLog {
  id: string;
  ruleId: string;
  sessionId: string;
  appliedAt: number;
  userAccepted?: number | null;
  causedConflict: number;
  contextSummary?: string;
}

export interface RelationshipProfile {
  userId: string;
  projectId: string;
  trustLevel: 'L1' | 'L2' | 'L3';
  frictionScore: number;
  repairNeeded: number;
  autonomyBudget: number;
  updatedAt: number;
}

export interface MemoryRepairJob {
  id: string;
  projectId: string;
  jobType: 'auto_alias' | 're_embed' | 're_group' | 'weight_adjust' | 'deprecate_rule';
  trigger: string;
  fragmentsAffected: string;
  actionTaken: string;
  beforeState?: string;
  afterState?: string;
  createdAt: number;
}

export interface AgentMessage {
  id: string;
  eventType: string;
  publisher: 'skill' | 'smallmodel' | 'agent';
  payload: string;
  consumed: number;
  consumedAt?: number;
  createdAt: number;
}

export interface FeatureFlag {
  id: string;
  flagName: string;
  enabled: number;
  rolloutPercentage: number;
  description?: string;
  updatedAt: number;
}

export interface InteractionStreamEntry {
  id: string;
  projectId: string;
  sessionId?: string;
  role: 'user' | 'assistant' | 'system';
  contentPreview: string;
  topicId?: string;
  continuityWindowMs?: number;
  createdAt: number;
}

// ── P1: Persona Carrier types ─────────────────────────────────────

export interface PersonaStyle {
  warmth: number;       // 温暖度/共情度 (0.0=冷漠, 1.0=极度共情)
  verbosity: number;    // 冗长度 (0.0=极简, 1.0=详细展开)
  humor: number;        // 幽默感 (0.0=严肃, 1.0=轻松幽默)
  formality: number;    // 正式度 (0.0=随意/口语化, 1.0=专业/书面)
  // v4 新增字段（运行时由 ML 推理填充，v3 降级路径不可用）
  scenario?: string;
  scenarioType?: number;
  tensions?: ContradictionTensions;
  dominantContradictions?: DominantContradiction[];
  resolutionStrategy?: string;
}

// ── v4 矛盾张力类型 ──────────────────────────────────────────

export interface ContradictionTensions {
  c1_understood_vs_hidden: number;
  c2_selfdeprecation_vs_stubborn: number;
  c3_fearforgetting_vs_acceptimpermanence: number;
  c4_desirecloseness_vs_keepdistance: number;
  c5_pursueeternity_vs_acceptfading: number;
  c6_idealism_vs_commercialreality: number;
  c7_publicduty_vs_privatewant: number;
  c8_optimistdeclaration_vs_pessimistundercurrent: number;
  c9_teamdependence_vs_coresolitude: number;
  c10_desireberemembered_vs_acceptoblivion: number;
}

export interface DominantContradiction {
  pair: string;
  pole: string;
  strength: number;
}

export interface PersonaInferenceInput {
  mood: number;
  energy: number;
  affinity: number;
  frustrationActive: boolean;
  context: string;
}

// ── P2: Mobile Context Ingestion ──────────────────────────────────
// 移动端薄壳 App 向服务端推送的情境数据
// 原则：最小必要 + 脱敏。绝不传输原始 GPS 坐标、健康明细、通知内容。

export interface MobileContextPayload {
  timestamp: number;       // Unix 毫秒
  device_id: string;       // 匿名设备标识（UUID，非设备序列号）
  // 宏观活动状态（手机端本地传感器融合后推断）
  activity_state: "idle" | "walking" | "driving" | "sleeping" | "working";
  // 手机端基于使用习惯的粗略情绪推断（可空）
  inferred_mood: "neutral" | "stressed" | "happy" | "fatigued" | null;
  // 仅基于地理围栏的粗略标签（非 GPS）
  location_context: "home" | "office" | "commute" | "unknown";
  // 电量 0-100，服务端据此减少主动推送
  battery_level: number;
}
