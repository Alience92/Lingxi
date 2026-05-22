export type Channel = "WHAT" | "FEEL" | "WHO" | "WHERE";
export type SignalSource = "behavior" | "clustering";

export interface FragmentAnchor {
  channel: Channel;
  label: string;
  weight: number;
  source: SignalSource;
  timestamp: number;
}

export interface Fragment {
  id: string;
  sessionId: string;
  projectId: string;
  anchors: FragmentAnchor[];
  linkedIds: string[];
  linkedCount: number;
  summary: string;
  decayScore: number;
  lastRecalledAt: number | null;
  recalledCount: number;
  createdAt: number;
  status: "active" | "archived" | "deleted";
}

export interface DistilledRule {
  id: string;
  text: string;
  sourceFragmentIds: string[];
  weight: number;
  projectIds: string[];
  createdAt: number;
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
  fragments: Omit<Fragment, "decayScore" | "lastRecalledAt" | "recalledCount" | "status">[];
  summary: string;
}

export interface PrefetchResult {
  contextBlock: string;
  fragmentIds: string[];
  confidence: number;
}

export interface InstallEstimate {
  fileCount: number;
  totalBytes: number;
  estimatedTokens: number;
  estimatedTimeMinutes: number;
  files: string[];
}
