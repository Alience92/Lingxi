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
