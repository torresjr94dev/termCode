export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  id: string;
  type: "split";
  direction: SplitDirection;
  ratio: number; // 0.1 to 0.9 (default 0.5)
  first: LayoutNode;
  second: LayoutNode;
}

export interface PaneNode {
  id: string;
  type: "pane";
  terminalId: string;
  title: string;
  cwd?: string;
  initialCommand?: string;
  agentType?: "cli" | "acp" | "claude" | "codex" | null;
}

export type LayoutNode = SplitNode | PaneNode;

export interface Tab {
  id: string;
  title: string;
  root: LayoutNode;
  activePaneId: string;
}

export interface AIUsageWindow {
  usedPercent: number;
  resetsAt?: string;
  windowMinutes?: number;
}

export interface AIUsageState {
  claude: {
    planType: string;
    fiveHour: AIUsageWindow;
    sevenDay: AIUsageWindow;
  };
  chatgpt: {
    planType: string;
    primary5h: AIUsageWindow;
    secondaryWeekly: AIUsageWindow;
  };
}
