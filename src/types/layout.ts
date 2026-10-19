export type SplitDirection = "horizontal" | "vertical";

export type AgentKind = "claude" | "codex";

export interface SplitNode {
  id: string;
  type: "split";
  direction: SplitDirection;
  ratio: number; // 0.15 to 0.85 (default 0.5)
  first: LayoutNode;
  second: LayoutNode;
}

export interface PaneNode {
  id: string;
  type: "pane";
  terminalId: string;
  title: string;
  /** Directory the process starts in (inherited from the pane it was split from). */
  cwd?: string;
  /** Command run through the login shell instead of a plain shell (agents). */
  command?: string;
  agentType?: AgentKind | null;
}

export type LayoutNode = SplitNode | PaneNode;

export interface Tab {
  id: string;
  title: string;
  root: LayoutNode;
  activePaneId: string;
}

/* ---- Datos que llegan del backend (ver src-tauri/src/usage) ---- */

export interface UsageWindow {
  kind: string;
  label: string;
  usedPercent: number;
  /** ISO-8601 o epoch (s/ms), tal como lo dio la fuente. */
  resetsAt: string | number | null;
  severity: string | null;
}

export type UsageStatus = "loading" | "ok" | "unavailable" | "expired" | "error";

export interface ProviderUsage {
  status: UsageStatus;
  plan: string | null;
  authMode: "subscription" | "api-key" | null;
  source: "statusline" | "oauth" | "session-log" | null;
  fetchedAt: number | null;
  windows: UsageWindow[];
  tokens24h: number | null;
  message: string | null;
}

export interface UsageSnapshot {
  claude: ProviderUsage;
  codex: ProviderUsage;
}

export interface AgentStatus {
  paneId: string;
  model: string | null;
  contextPercent: number | null;
  costUsd: number | null;
}

export interface AgentAttention {
  paneId: string;
  kind: "needs-input" | "done" | "bell" | "notify" | string;
  message: string;
}

export interface AgentsInfo {
  claude: string | null;
  codex: string | null;
  gh: string | null;
  claudeSettingsPath: string | null;
}

export interface ProcessInfo {
  shellPid: number | null;
  foregroundPid: number | null;
  foregroundName: string | null;
  cwd: string | null;
  busy: boolean;
}
