import { useTerminalStore, type PaneSpec } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager, FONT_SIZE } from "../terminal/TerminalManager";
import { basename, collectPanes, findOwnerTab, findPane } from "./layout";
import { ipc, shellQuote } from "./ipc";
import type { AgentKind, SplitDirection } from "../types/layout";

export type { AgentKind };

export const AGENTS: Record<AgentKind, { title: string; command: string; vendor: string; install: string }> = {
  claude: {
    title: "Claude Code",
    command: "claude",
    vendor: "Anthropic",
    install: "npm install -g @anthropic-ai/claude-code",
  },
  codex: { title: "Codex CLI", command: "codex", vendor: "OpenAI", install: "npm install -g @openai/codex" },
};

const state = () => useTerminalStore.getState();
const ui = () => useUiStore.getState();

function activeTab() {
  const { tabs, activeTabId } = state();
  return tabs.find((tab) => tab.id === activeTabId);
}

function activePaneId(): string | undefined {
  return activeTab()?.activePaneId;
}

/** Directorio real del proceso en primer plano del panel (no el de arranque). */
async function cwdOf(paneId: string | undefined): Promise<string | undefined> {
  if (!paneId) return undefined;
  const info = await terminalManager.info(paneId);
  if (info?.cwd) return info.cwd;
  const tab = findOwnerTab(state().tabs, paneId);
  return tab ? findPane(tab.root, paneId)?.cwd : undefined;
}

/** `false` (con aviso) si sabemos que el agente no está instalado. */
function agentAvailable(agent: AgentKind): boolean {
  const agents = state().agents;
  if (agents && !agents[agent]) {
    ui().showToast(`${AGENTS[agent].title} no está instalado. Instálalo con: ${AGENTS[agent].install}`, "error");
    return false;
  }
  return true;
}

function agentSpec(agent: AgentKind, cwd?: string, title?: string): PaneSpec {
  const settings = agent === "claude" ? state().agents?.claudeSettingsPath : null;
  // Claude recibe nuestro statusLine + hooks solo en las sesiones lanzadas desde termCode.
  const command = settings ? `${AGENTS.claude.command} --settings ${shellQuote(settings)}` : AGENTS[agent].command;
  return { title: title ?? AGENTS[agent].title, agentType: agent, command, cwd };
}

async function split(direction: SplitDirection, spec: PaneSpec = {}) {
  const target = activePaneId();
  if (!target) return;
  const cwd = spec.cwd ?? (await cwdOf(target));
  state().splitPane(target, direction, { ...spec, cwd });
}

/** Cierra si no hay nada corriendo; si lo hay, pide confirmación primero. */
async function confirmIfBusy(paneIds: string[], what: string, close: () => void) {
  const infos = await Promise.all(paneIds.map((id) => terminalManager.info(id)));
  const busy = [...new Set(infos.filter((i) => i?.busy).map((i) => i?.foregroundName ?? "un proceso"))];
  if (!busy.length) {
    close();
    return;
  }
  ui().askConfirm({
    title: `¿Cerrar ${what}?`,
    body: `${busy.join(", ")} ${busy.length === 1 ? "sigue" : "siguen"} en ejecución y se ${busy.length === 1 ? "detendrá" : "detendrán"}.`,
    confirmLabel: "Cerrar",
    onConfirm: close,
  });
}

/**
 * Acciones de la app sin dependencias de React: las comparten el teclado,
 * la paleta, la barra lateral y el popover de cuotas.
 */
export const actions = {
  newTab: async () => {
    const cwd = await cwdOf(activePaneId());
    state().createTab({ cwd });
  },

  closePane: (paneId = activePaneId()) => {
    if (!paneId) return;
    void confirmIfBusy([paneId], "el panel", () => state().closePane(paneId));
  },

  closeTab: (tabId: string) => {
    const tab = state().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const panes = collectPanes(tab.root).map((p) => p.id);
    void confirmIfBusy(panes, "la pestaña", () => state().closeTab(tabId));
  },

  splitRight: () => split("horizontal"),
  splitDown: () => split("vertical"),

  /** El agente a la derecha del panel activo, en su mismo directorio. */
  openAgentInSplit: async (agent: AgentKind) => {
    if (!agentAvailable(agent)) return;
    const cwd = await cwdOf(activePaneId());
    await split("horizontal", agentSpec(agent, cwd));
  },

  openAgentInTab: async (agent: AgentKind) => {
    if (!agentAvailable(agent)) return;
    const cwd = await cwdOf(activePaneId());
    state().createTab(agentSpec(agent, cwd));
  },

  /** Worktree nuevo (rama propia) + agente dentro: varios agentes sin pisarse. */
  openAgentInWorktree: async (agent: AgentKind) => {
    if (!agentAvailable(agent)) return;
    const cwd = await cwdOf(activePaneId());
    if (!cwd) {
      ui().showToast("No sé en qué carpeta está el panel activo.", "error");
      return;
    }
    try {
      const path = await ipc.worktreeCreate(cwd, agent);
      state().createTab(agentSpec(agent, path, `${AGENTS[agent].title} · ${basename(path)}`));
      ui().showToast(`Worktree creado en ${path}`);
    } catch (err) {
      ui().showToast(String(err), "error");
    }
  },

  /** Pega la selección del panel activo en el agente más cercano. */
  sendSelectionToAgent: () => {
    const { tabs } = state();
    const source = activePaneId();
    const text = source ? terminalManager.getSelection(source).trim() : "";
    if (!text) {
      ui().showToast("Selecciona texto en el terminal primero.");
      return;
    }
    const current = activeTab();
    const candidates = [
      ...(current ? collectPanes(current.root) : []),
      ...tabs.filter((t) => t !== current).flatMap((t) => collectPanes(t.root)),
    ];
    const target = candidates.find((p) => p.agentType && p.id !== source);
    if (!target) {
      ui().showToast("No hay ningún agente abierto.");
      return;
    }
    const owner = findOwnerTab(tabs, target.id);
    if (owner) state().setActiveTab(owner.id);
    terminalManager.paste(target.id, text);
    state().setActivePane(target.id);
  },

  focusPaneOffset: (delta: number) => {
    const tab = activeTab();
    if (!tab) return;
    const panes = collectPanes(tab.root);
    if (panes.length < 2) return;
    const index = panes.findIndex((pane) => pane.id === tab.activePaneId);
    state().setActivePane(panes[(index + delta + panes.length) % panes.length].id);
  },

  goToTab: (index: number) => {
    const target = state().tabs[index];
    if (target) state().setActiveTab(target.id);
  },

  focusPane: (tabId: string, paneId: string) => {
    state().setActiveTab(tabId);
    state().setActivePane(paneId);
  },

  toggleFind: () => {
    const paneId = activePaneId();
    if (!paneId) return;
    const open = ui().findPaneId === paneId;
    ui().setFindPane(open ? null : paneId);
    if (open) {
      terminalManager.clearSearch(paneId);
      terminalManager.focus(paneId);
    }
  },

  fontBigger: () => state().setFontSize(state().fontSize + 1),
  fontSmaller: () => state().setFontSize(state().fontSize - 1),
  fontReset: () => state().setFontSize(FONT_SIZE.default),

  refreshUsage: () => void ipc.usageRefresh(),
  toggleSidebar: () => state().toggleSidebar(),
  toggleUsage: () => state().toggleUsageDrawer(),
  toggleBroadcast: () => state().toggleBroadcast(),
};
