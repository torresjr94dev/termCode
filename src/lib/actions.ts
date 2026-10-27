import { liveAgent, useTerminalStore, type PaneSpec } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { DEFAULT_SETTINGS, settingsNow, useSettingsStore } from "../store/settingsStore";
import { basename, collectPanes, findOwnerTab, findPane } from "./layout";
import { ipc, powershellQuote, shellQuote } from "./ipc";
import { agentCommand, type AgentCommandOptions } from "./resume";
import { cdKeystrokes, lineKeystrokes } from "./cd";
import { nextAttentionPane } from "./attention";
import { IS_WINDOWS } from "./shortcuts";
import { useApprovalStore } from "../store/approvalStore";
import type { AgentKind, PaneShell, ShellInfo, SplitDirection } from "../types/layout";

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
export async function cwdOf(paneId: string | undefined): Promise<string | undefined> {
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

export function agentSpec(
  agent: AgentKind,
  cwd?: string,
  title?: string,
  prompt?: string,
  resume?: AgentCommandOptions["resume"],
): PaneSpec {
  const { claudeSettingsPath, mcpConfigPath } = state().agents ?? {};
  // Claude recibe statusLine + hooks (y el MCP de lectura) solo en sesiones lanzadas desde termCode.
  // Al reanudar se pasan de nuevo: la sesión no los recuerda.
  const command = agentCommand(agent, AGENTS[agent].command, shellQuote, {
    settingsPath: claudeSettingsPath,
    mcpConfigPath: settingsNow().agentsReadPanes ? mcpConfigPath : null,
    prompt,
    resume,
  });
  return { title: title ?? AGENTS[agent].title, agentType: agent, command, cwd };
}

/**
 * Lo que se teclea para abrir el agente en la shell de un panel. En zsh con
 * la integración basta `claude`: su función le pasa el `--settings` de
 * termCode (statusLine y hooks). En otra shell va la línea completa.
 */
function typedAgent(agent: AgentKind, paneId: string): string {
  const wrapped = !IS_WINDOWS && Boolean(terminalManager.getTracker(paneId)?.integrated);
  if (wrapped) return lineKeystrokes(AGENTS[agent].command);
  const { claudeSettingsPath, mcpConfigPath } = state().agents ?? {};
  return lineKeystrokes(
    agentCommand(agent, AGENTS[agent].command, IS_WINDOWS ? powershellQuote : shellQuote, {
      settingsPath: claudeSettingsPath,
      mcpConfigPath: settingsNow().agentsReadPanes ? mcpConfigPath : null,
    }),
  );
}

/** La shell de las pestañas nuevas según Ajustes (undefined = la del sistema). */
function defaultShell(): PaneShell | undefined {
  const path = settingsNow().defaultShell;
  const found = path ? state().shells?.find((s) => s.path === path) : undefined;
  return found && !found.default ? { name: found.name, path: found.path, args: found.args } : undefined;
}

async function split(direction: SplitDirection, spec: PaneSpec = {}) {
  const target = activePaneId();
  if (!target) return;
  const cwd = spec.cwd ?? (await cwdOf(target));
  // Una división de una pestaña de bash también es bash (salvo que sea un agente).
  const tab = activeTab();
  const shell = spec.command ? undefined : (spec.shell ?? (tab ? findPane(tab.root, target)?.shell : undefined));
  state().splitPane(target, direction, { ...spec, cwd, ...(shell ? { shell } : {}) });
}

/** Recuerda carpeta y título de lo que se cierra, para ⌘⇧T. */
async function remember(paneIds: string[], title: string) {
  const cwds = (await Promise.all(paneIds.map((id) => cwdOf(id)))).filter((c): c is string => Boolean(c));
  state().rememberClosed({ title, cwds });
}

/** Cierra si no hay nada corriendo; si lo hay, pide confirmación primero. */
async function confirmIfBusy(paneIds: string[], what: string, close: () => void) {
  const closeAndRemember = () => {
    void remember(paneIds, what).finally(close);
  };
  if (!settingsNow().confirmClose) {
    closeAndRemember();
    return;
  }
  const infos = await Promise.all(paneIds.map((id) => terminalManager.info(id)));
  const busy = [...new Set(infos.filter((i) => i?.busy).map((i) => i?.foregroundName ?? "un proceso"))];
  if (!busy.length) {
    closeAndRemember();
    return;
  }
  ui().askConfirm({
    title: `¿Cerrar ${what}?`,
    body: `${busy.join(", ")} ${busy.length === 1 ? "sigue" : "siguen"} en ejecución y se ${busy.length === 1 ? "detendrá" : "detendrán"}.`,
    confirmLabel: "Cerrar",
    onConfirm: closeAndRemember,
  });
}

/**
 * Protección de cuota: con la ventana de 5 h casi agotada, lanzar un agente
 * cuesta trabajo a medias. Avisa con cuándo se reinicia.
 */
function guardQuota(agent: AgentKind, launch: () => void) {
  const provider = agent === "claude" ? state().usage.claude : state().usage.codex;
  const session = provider.windows.find((w) => w.kind === "session");
  if (!settingsNow().quotaGuard || !session || session.usedPercent < 90) {
    launch();
    return;
  }
  const resets = session.resetsAt ? new Date(typeof session.resetsAt === "number" && session.resetsAt < 1e12 ? session.resetsAt * 1000 : session.resetsAt) : null;
  const when = resets && !Number.isNaN(resets.getTime()) ? ` Se reinicia a las ${resets.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}.` : "";
  ui().askConfirm({
    title: `La sesión de ${AGENTS[agent].title} está al ${Math.round(session.usedPercent)}%`,
    body: `Es probable que el agente se quede sin cuota a medio trabajo.${when}`,
    confirmLabel: "Lanzar igualmente",
    onConfirm: launch,
  });
}

/**
 * Acciones de la app sin dependencias de React: las comparten el teclado,
 * la paleta, la barra lateral y el popover de cuotas.
 */
export const actions = {
  newTab: async () => {
    const cwd = await cwdOf(activePaneId());
    state().createTab({ cwd, shell: defaultShell() });
  },

  /** Pestaña nueva con una shell concreta (la predeterminada se abre como siempre). */
  newTabWith: async (shell: ShellInfo) => {
    const cwd = await cwdOf(activePaneId());
    state().createTab({ cwd, ...(shell.default ? {} : { shell: { name: shell.name, path: shell.path, args: shell.args } }) });
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

  /** El agente a la derecha del panel activo, en su mismo directorio (con un primer mensaje, si lo hay). */
  openAgentInSplit: async (agent: AgentKind, prompt?: string) => {
    if (!agentAvailable(agent)) return;
    const cwd = await cwdOf(activePaneId());
    guardQuota(agent, () => void split("horizontal", agentSpec(agent, cwd, undefined, prompt)));
  },

  /**
   * El agente en este mismo panel, como si lo escribieras: se teclea `claude`
   * (o `codex`) en su shell y al salir vuelves a ella, con su carpeta, su
   * entorno y su historial. Si la shell no está libre (algo corre o ya hay un
   * agente), se abre junto al panel y se dice por qué.
   */
  openAgentHere: async (agent: AgentKind, paneId = activePaneId()) => {
    if (!paneId || !agentAvailable(agent)) return;
    const tab = findOwnerTab(state().tabs, paneId);
    const pane = tab ? findPane(tab.root, paneId) : undefined;
    if (!pane) return;
    const present = liveAgent(state(), pane);
    const info = present ? null : await terminalManager.info(paneId);
    if (!info || info.busy) {
      const why = present
        ? `${AGENTS[present].title} ya está en este panel`
        : info?.busy
          ? `${info.foregroundName ?? "Un programa"} sigue corriendo`
          : "La terminal aún no arranca";
      ui().showToast(`${why}: ${AGENTS[agent].title} se abre junto al panel.`);
      state().setActivePane(paneId, { focus: false });
      await actions.openAgentInSplit(agent);
      return;
    }
    guardQuota(agent, () => terminalManager.run(paneId, typedAgent(agent, paneId)));
  },

  openAgentInTab: async (agent: AgentKind) => {
    if (!agentAvailable(agent)) return;
    const cwd = await cwdOf(activePaneId());
    guardQuota(agent, () => state().createTab(agentSpec(agent, cwd)));
  },

  /**
   * Conecta por SSH en una pestaña (o junto al panel). Corre en tu shell de
   * login: al salir de ssh, el panel sigue siendo una terminal local.
   */
  connectSsh: (name: string, command: string | null, where: "tab" | "split" = "tab") => {
    if (!command) {
      ui().showToast(`${name}: datos de conexión no válidos.`, "error");
      return;
    }
    const spec: PaneSpec = { title: `ssh · ${name}`, command, ssh: name };
    if (where === "split") void split("horizontal", spec);
    else state().createTab(spec);
  },

  /** Shell o agente en pestaña nueva, en una carpeta concreta (p. ej. una reciente). */
  openHere: (kind: "shell" | AgentKind, cwd: string) => {
    if (kind === "shell") {
      state().createTab({ cwd, shell: defaultShell() });
      return;
    }
    if (!agentAvailable(kind)) return;
    guardQuota(kind, () => state().createTab(agentSpec(kind, cwd)));
  },

  /**
   * Lleva el panel activo a `path` con `cd`. Solo se teclea en una shell
   * libre: en un agente, o con algo corriendo, las teclas irían a ese
   * programa. Entonces la carpeta se abre en una pestaña nueva, y se avisa.
   */
  cdTo: async (path: string) => {
    const tab = activeTab();
    const pane = tab ? findPane(tab.root, tab.activePaneId) : undefined;
    if (!pane) {
      state().createTab({ cwd: path });
      return;
    }
    const info = pane.agentType || pane.command ? null : await terminalManager.info(pane.id);
    if (!info || info.busy) {
      state().createTab({ cwd: path });
      const why = pane.agentType ? `${AGENTS[pane.agentType].title} está en el panel activo` : info?.busy ? `${info.foregroundName ?? "Un programa"} sigue corriendo` : "La terminal aún no arranca";
      ui().showToast(`${why}: ${basename(path)} se abrió en una pestaña nueva.`);
      return;
    }
    terminalManager.run(pane.id, cdKeystrokes(path));
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

  /**
   * El panel restaurado vuelve a ser el agente que era: Claude retoma su
   * conversación (`--resume <id>`), Codex la última de esa carpeta.
   */
  resumeAgent: async (paneId: string) => {
    const owner = findOwnerTab(state().tabs, paneId);
    const pane = owner ? findPane(owner.root, paneId) : undefined;
    const info = pane?.resumable;
    if (!pane || !info || !agentAvailable(info.agent)) return;
    const resume = info.sessionId ?? (info.agent === "codex" ? "last" : undefined);
    const relaunch = () => {
      const fresh = state().replacePane(paneId, agentSpec(info.agent, pane.cwd, info.title, undefined, resume));
      if (fresh && owner?.id === state().activeTabId) setTimeout(() => state().setActivePane(fresh), 0);
    };
    // La shell restaurada puede tener algo corriendo: no se mata sin preguntar.
    const busy = await terminalManager.info(paneId);
    guardQuota(info.agent, () => {
      if (!busy?.busy) {
        relaunch();
        return;
      }
      ui().askConfirm({
        title: `¿Reanudar ${AGENTS[info.agent].title} aquí?`,
        body: `${busy.foregroundName ?? "Un proceso"} sigue corriendo en este panel y se detendrá.`,
        confirmLabel: "Reanudar",
        onConfirm: relaunch,
      });
    });
  },

  /** Pega texto en el agente más cercano (primero el de esta pestaña). */
  sendTextToAgent: (text: string) => {
    const { tabs } = state();
    const source = activePaneId();
    if (!text.trim()) return;
    const current = activeTab();
    const candidates = [
      ...(current ? collectPanes(current.root) : []),
      ...tabs.filter((t) => t !== current).flatMap((t) => collectPanes(t.root)),
    ];
    const target = candidates.find((p) => liveAgent(state(), p) && p.id !== source);
    if (!target) {
      ui().showToast("No hay ningún agente abierto.");
      return;
    }
    const owner = findOwnerTab(tabs, target.id);
    if (owner) state().setActiveTab(owner.id);
    terminalManager.paste(target.id, text);
    state().setActivePane(target.id);
  },

  /** Pega la selección del panel activo en el agente más cercano. */
  sendSelectionToAgent: () => {
    const source = activePaneId();
    const text = source ? terminalManager.getSelection(source).trim() : "";
    if (!text) {
      ui().showToast("Selecciona texto en el terminal primero.");
      return;
    }
    actions.sendTextToAgent(text);
  },

  focusPaneOffset: (delta: number) => {
    const tab = activeTab();
    if (!tab) return;
    const panes = collectPanes(tab.root);
    if (panes.length < 2) return;
    const index = panes.findIndex((pane) => pane.id === tab.activePaneId);
    state().setActivePane(panes[(index + delta + panes.length) % panes.length].id);
  },

  /** ⌘J: al panel que te necesita (el bloqueado que más lleva esperando, primero). */
  focusNextAttention: () => {
    const { tabs, attention, agentActivity } = state();
    const target = nextAttentionPane(tabs, attention, agentActivity, activePaneId(), useApprovalStore.getState().requests);
    if (!target) {
      ui().showToast("Nadie te necesita ahora.");
      return;
    }
    // Ver el panel es atenderlo: la marca se va al llegar (como al hacer clic).
    actions.focusPane(target.tabId, target.paneId);
    state().setAttention(target.paneId, null);
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

  fontBigger: () => useSettingsStore.getState().update({ fontSize: settingsNow().fontSize + 1 }),
  fontSmaller: () => useSettingsStore.getState().update({ fontSize: settingsNow().fontSize - 1 }),
  fontReset: () => useSettingsStore.getState().update({ fontSize: DEFAULT_SETTINGS.fontSize }),

  /** ⌘⇧T: reabre lo último cerrado en su carpeta (una pestaña por panel cerrado). */
  reopenClosed: () => {
    const entry = state().popClosed();
    if (!entry) {
      ui().showToast("No hay nada cerrado que reabrir.");
      return;
    }
    const cwds = entry.cwds.length ? entry.cwds : [undefined];
    cwds.forEach((cwd) => state().createTab({ cwd }));
  },

  jumpCommand: (direction: -1 | 1) => {
    const paneId = activePaneId();
    if (!paneId) return;
    if (!terminalManager.getTracker(paneId)?.integrated) {
      ui().showToast("Saltar entre comandos necesita la integración con zsh (Ajustes → Terminal).");
      return;
    }
    terminalManager.jumpToCommand(paneId, direction);
  },

  /**
   * ⌘L: la terminal acoplada del agente (en su carpeta, sin dividir). La
   * primera vez se crea; después se pliega y despliega. El teclado va a donde
   * quedó a la vista.
   */
  toggleAgentShell: (paneId = activePaneId()) => {
    const tab = paneId ? findOwnerTab(state().tabs, paneId) : undefined;
    const pane = tab && paneId ? findPane(tab.root, paneId) : undefined;
    if (!pane) return;
    // Una ya abierta se puede plegar aunque el agente haya salido.
    if (!liveAgent(state(), pane) && !pane.drawer) {
      ui().showToast("La terminal acoplada es para paneles de agente; para otra shell aquí, divide el panel.");
      return;
    }
    const opening = !pane.drawer?.open;
    state().toggleDrawer(pane.id, opening);
    requestAnimationFrame(() => {
      const fresh = findPane(findOwnerTab(state().tabs, pane.id)?.root ?? pane, pane.id);
      terminalManager.focus(opening && fresh?.drawer ? fresh.drawer.id : pane.id);
    });
  },

  toggleZoom: () => state().toggleZoom(),
  equalizeSplits: () => state().equalizeSplits(),
  openSettings: () => ui().setSettingsOpen(true),

  refreshUsage: () => void ipc.usageRefresh(),
  toggleSidebar: () => state().toggleSidebar(),
  toggleUsage: () => state().toggleUsageDrawer(),
  toggleBroadcast: () => state().toggleBroadcast(),
};
