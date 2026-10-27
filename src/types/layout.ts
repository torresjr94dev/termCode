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

/** Una shell instalada (ver src-tauri/src/shells.rs). */
export interface ShellInfo {
  name: string;
  path: string;
  args: string[];
  /** La de siempre: se abre sin `program` y conserva la integración del sistema. */
  default: boolean;
}

/** Shell elegida para un panel (la predeterminada no se guarda: es la ausencia de esto). */
export interface PaneShell {
  name: string;
  path: string;
  args: string[];
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
  /** Shell elegida para este panel (zsh, bash, fish, pwsh…); sin esto, la tuya. */
  shell?: PaneShell;
  /** Conexión SSH de este panel (el nombre del servidor). */
  ssh?: string;
  agentType?: AgentKind | null;
  /** Sesión del agente que corre aquí (la reportan los hooks de Claude Code). */
  agentSession?: AgentSessionRef;
  /** Al restaurar: aquí había un agente y se puede reanudar con un clic. */
  resumable?: ResumableAgent;
  /** Pestaña de shell recién abierta: muestra la bienvenida antes del prompt (no se guarda). */
  welcome?: boolean;
  /** Shell acoplada abajo del agente, en su carpeta, sin dividir el panel. */
  drawer?: PaneDrawer;
}

export interface PaneDrawer {
  /** Id de su terminal (no es un panel del árbol). */
  id: string;
  /** Plegada queda una barra; la shell sigue viva. */
  open: boolean;
  /** Alto respecto al panel, 0.15–0.75. */
  ratio: number;
}

export interface AgentSessionRef {
  id: string;
  /** Último mensaje que le mandaste (resumido). */
  prompt?: string;
  at: number;
}

export interface ResumableAgent {
  agent: AgentKind;
  /** `null`: no se sabe (Codex, o Claude sin mensajes): se abre de nuevo o la última de la carpeta. */
  sessionId: string | null;
  title: string;
  prompt?: string;
  at?: number;
}

export type LayoutNode = SplitNode | PaneNode;

export interface Tab {
  id: string;
  title: string;
  /** Nombre puesto a mano (doble clic en la pestaña); manda sobre el título vivo. */
  customTitle?: string;
  root: LayoutNode;
  activePaneId: string;
  /** Panel maximizado dentro de la pestaña (⌘⇧↵). */
  zoomedPaneId?: string | null;
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
  /** Los mismos tokens por hora: 24 valores, el último es la hora en curso. */
  tokensByHour: number[] | null;
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

export interface AgentActivity {
  paneId: string;
  /** working · needs-input · idle */
  state: string;
  detail: string;
  at: number;
  /**
   * De dónde salió: `osc` lo dijo el propio programa por su PTY (OSC 7501) y
   * manda sobre `hook` (archivos de los hooks de Claude Code, por sondeo).
   */
  source?: "osc" | "hook";
  /** Programa que se anunció por OSC 7501 (`claude-code`, `codex`…). */
  app?: string | null;
}

export interface AgentSessionEvent {
  paneId: string;
  sessionId: string;
  prompt: string | null;
  at: number;
}

export interface AgentWorktree {
  path: string;
  branch: string;
  /** Commit del que partió el agente. */
  base: string;
  commits: number;
  changed: number;
  insertions: number;
  deletions: number;
}

export interface BaselineSnapshot {
  root: string;
  sha: string;
  untracked: string[];
  at: number;
}

export interface AgentBaseline {
  session: BaselineSnapshot;
  turn: BaselineSnapshot;
}

export interface AgentsInfo {
  claude: string | null;
  codex: string | null;
  gh: string | null;
  /** Editores encontrados en tu PATH: cursor, code, zed, subl. */
  editors: string[];
  claudeSettingsPath: string | null;
  mcpConfigPath: string | null;
}

/* ---- Monitor del sistema (ver src-tauri/src/sysmon.rs) ---- */

export interface ProcessUsage {
  pid: number;
  name: string;
  /** Por núcleo, como Monitor de Actividad: puede pasar de 100. */
  cpuPercent: number;
  memory: number;
  /** Es tuyo: se puede terminar sin privilegios. */
  mine: boolean;
}

export interface SystemStats {
  /** Todos los núcleos juntos, 0–100. */
  cpuPercent: number;
  cpuCount: number;
  /** Cada núcleo, 0–100. */
  cpuCores: number[];
  /** Carga media de 1, 5 y 15 min (null en Windows). */
  loadAverage: [number, number, number] | null;
  uptimeSecs: number;
  memoryUsed: number;
  memoryTotal: number;
  /** Lo que las apps pueden pedir sin que el sistema libere nada. */
  memoryAvailable: number;
  swapUsed: number;
  swapTotal: number;
  /** Solo macOS. */
  memoryPressure: "normal" | "warn" | "critical" | null;
  /** Solo macOS. */
  gpuPercent: number | null;
  gpuMemory: number | null;
  /** De más a menos memoria; vacío si no se pidieron procesos. */
  top: ProcessUsage[];
}

export interface ProcessInfo {
  shellPid: number | null;
  foregroundPid: number | null;
  foregroundName: string | null;
  cwd: string | null;
  busy: boolean;
}
