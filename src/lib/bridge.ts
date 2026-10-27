import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { findDrawerOwner, liveAgent, useTerminalStore } from "../store/terminalStore";
import { useSidebarStore } from "../store/sidebarStore";
import { useUiStore } from "../store/uiStore";
import { settingsNow } from "../store/settingsStore";
import { terminalManager } from "../terminal/TerminalManager";
import { commandAgent, type CommandRecord } from "../terminal/commands";
import type { ProgramState, ProgramStatus } from "../terminal/programStatus";
import type { FileLinkTarget } from "../terminal/links";
import { collectPanes, findOwnerTab, findPane } from "./layout";
import { IS_TAURI, ipc } from "./ipc";
import { formatDuration } from "./format";
import { startApprovals } from "./approvals";
import { onAgentDone } from "./race";
import { cleanTitle } from "./identity";
import { info as logInfo } from "@tauri-apps/plugin-log";
import { basename } from "./paths";

const state = () => useTerminalStore.getState();
/** Paneles que ya avisaron de su integración (una línea de log por panel). */
const integrated = new Set<string>();
/** Codex no tiene statusLine: su contexto se lee del rollout cada pocos segundos. */
const CODEX_POLL_MS = 3000;
/** Puertos en escucha de los paneles (una sola consulta para todos). */
const PORTS_POLL_MS = 4000;

let notificationsAllowed: boolean | null = null;

export async function notify(title: string, body: string) {
  if (!IS_TAURI) return;
  try {
    if (notificationsAllowed === null) {
      notificationsAllowed = await isPermissionGranted();
      if (!notificationsAllowed) notificationsAllowed = (await requestPermission()) === "granted";
    }
    if (notificationsAllowed) sendNotification({ title, body });
  } catch (err) {
    console.warn("[termCode] notificación:", err);
  }
}

function isLookingAt(paneId: string): boolean {
  const { tabs, activeTabId } = state();
  const tab = tabs.find((t) => t.id === activeTabId);
  return document.hasFocus() && tab?.activePaneId === paneId;
}

/**
 * Un panel pide atención (el agente terminó, necesita permiso, sonó la
 * campana…). Si el usuario ya lo está mirando no hacemos nada; si no, se marca
 * en pestaña/barra lateral y, con la ventana en segundo plano, llega una
 * notificación del sistema.
 */
function raiseAttention(paneId: string, kind: string, message: string) {
  if (isLookingAt(paneId)) return;
  const { tabs } = state();
  const owner = findOwnerTab(tabs, paneId);
  const pane = owner ? findPane(owner.root, paneId) : undefined;
  if (!pane) return;

  state().setAttention(paneId, { kind, message, at: Date.now() });
  if (document.hasFocus()) return;

  const who = pane.title || "Terminal";
  const title =
    kind === "done" ? `${who} terminó` : kind === "needs-input" ? `${who} necesita tu atención` : who;
  void notify(title, message || (kind === "bell" ? "Campana en el terminal" : ""));
}

/** OSC 7501 → estado de la interfaz. `done` y `error` son "esperando instrucciones" con aviso. */
const OSC_STATE: Record<Exclude<ProgramState, "clear">, string> = {
  working: "working",
  blocked: "needs-input",
  idle: "idle",
  done: "idle",
  error: "idle",
};

/** El último estado OSC de cada panel: avisar solo al cambiar, no en cada repetición. */
const lastProgramState = new Map<string, ProgramState>();

/** Un "te necesita" ya resuelto (el agente siguió): fuera la marca, aunque no hayas pasado por el panel. */
function settleNeedsInput(paneId: string) {
  if (state().attention[paneId]?.kind === "needs-input") state().setAttention(paneId, null);
}

/**
 * El programa del panel dijo qué hace (OSC 7501, ver `programStatus.ts`).
 * Es la fuente buena: llega por el PTY de ese panel, así que no se cruza con
 * otro, y cuando existe manda sobre los hooks.
 */
function onProgramStatus(paneId: string, status: ProgramStatus) {
  const previous = lastProgramState.get(paneId);
  if (status.state === "clear") {
    lastProgramState.delete(paneId);
    if (state().agentActivity[paneId]?.source === "osc") state().clearAgentActivity(paneId);
    settleNeedsInput(paneId);
    return;
  }
  lastProgramState.set(paneId, status.state);
  const current = state().agentActivity[paneId];
  state().setAgentActivity({
    paneId,
    state: OSC_STATE[status.state],
    detail: status.msg ?? status.title ?? (status.state === "working" ? (current?.detail ?? "") : ""),
    at: status.state === previous && current ? current.at : Date.now(),
    source: "osc",
    app: status.app ?? current?.app ?? null,
  });
  if (status.state === previous) return;

  const message = status.msg ?? "";
  if (status.state === "blocked") raiseAttention(paneId, "needs-input", message);
  else settleNeedsInput(paneId);
  if (status.state === "done") raiseAttention(paneId, "done", message);
  if (status.state === "error") raiseAttention(paneId, "failed", message);
}

/**
 * Un `claude` o `codex` escrito en la shell: el panel cuenta como agente desde
 * ya (cabecera, barra de estado, Mission Control), sin esperar a que el
 * agente se anuncie por OSC 7501, cosa que Codex y los Claude viejos no hacen.
 */
function onCommandStart(paneId: string, command: string) {
  const agent = commandAgent(command);
  if (agent) state().setRunningAgent(paneId, agent);
}

/**
 * Volvió el prompt de la shell: lo que corría ya no está. Un agente escrito a
 * mano se lleva su modelo y su contexto (el panel vuelve a ser una shell). Si
 * reportaba por OSC 7501 y salió sin decir `clear` (se cerró de golpe), el
 * spec deja ver un `done` hasta que lo mires; eso ya lo guarda la marca de
 * atención, así que el panel deja de contar como agente.
 */
function onPrompt(paneId: string) {
  const owner = findOwnerTab(state().tabs, paneId);
  if (owner && !findPane(owner.root, paneId)?.agentType) {
    state().setRunningAgent(paneId, null);
    state().clearAgentStatus(paneId);
  }
  if (!lastProgramState.delete(paneId)) return;
  if (state().agentActivity[paneId]?.source === "osc") state().clearAgentActivity(paneId);
  settleNeedsInput(paneId);
}

/** El panel ya reporta por OSC 7501: lo que digan sus hooks llega tarde y sobra. */
const reportsByOsc = (paneId: string) => state().agentActivity[paneId]?.source === "osc";

/**
 * Comando largo terminado mientras no mirabas: notificación del sistema con
 * ✓/✗, y lámpara de atención en su pestaña.
 */
function onCommandFinished(paneId: string, record: CommandRecord) {
  const settings = settingsNow();
  const duration = (record.endedAt ?? Date.now()) - record.startedAt;
  if (!settings.notifyLongCommands || duration < settings.longCommandSeconds * 1000) return;
  if (isLookingAt(paneId)) return;
  const ok = record.exitCode === 0;
  const name = record.command.split("\n")[0].slice(0, 80) || "Comando";
  state().setAttention(paneId, { kind: ok ? "done" : "failed", message: name, at: Date.now() });
  if (!document.hasFocus()) {
    void notify(
      `${ok ? "✓" : "✗"} ${name}`,
      ok ? `Terminó en ${formatDuration(duration)}` : `Falló (código ${record.exitCode ?? "?"}) tras ${formatDuration(duration)}`,
    );
  }
}

/** ⌘-clic en una ruta: tu editor en la línea exacta, o el visor de termCode. */
async function openPath(target: FileLinkTarget) {
  const settings = settingsNow();
  const { openFileAbsolute } = await import("./project");
  if (settings.openPathsIn === "viewer" && openFileAbsolute(target.absolute, target.line)) return;
  try {
    await invoke("open_in_editor", {
      path: target.absolute,
      line: target.line ?? null,
      column: target.column ?? null,
      editor: settings.editor,
    });
  } catch (err) {
    // Sin editor disponible: el visor, si el archivo es del proyecto.
    if (!openFileAbsolute(target.absolute, target.line)) {
      useUiStore.getState().showToast(`No se pudo abrir ${target.absolute}: ${String(err)}`, "error");
    }
  }
}

/** Raíz de repo por carpeta: un `cd` dentro del mismo proyecto no relanza git. */
const repoCache = new Map<string, { root: string; name: string } | null>();

async function resolveProject(paneId: string, cwd: string) {
  const folder = basename(cwd);
  // Respuesta inmediata con la carpeta; el repo llega después (o sale de la caché).
  const cached = repoCache.get(cwd);
  if (cached !== undefined || !IS_TAURI) {
    state().setPaneProject(paneId, { cwd, name: cached?.name ?? folder, root: cached?.root ?? null });
    return;
  }
  const previous = state().paneProject[paneId];
  // Mientras git responde se conserva el proyecto anterior: sin parpadeo de color al hacer cd.
  if (!previous) state().setPaneProject(paneId, { cwd, name: folder, root: null });
  try {
    const { gitApi } = await import("./git");
    const repo = await gitApi.repo(cwd);
    const info = repo ? { root: repo.root, name: repo.name } : null;
    if (repoCache.size > 500) repoCache.clear();
    repoCache.set(cwd, info);
    state().setPaneProject(paneId, { cwd, name: info?.name ?? folder, root: info?.root ?? null });
  } catch {
    repoCache.set(cwd, null);
    state().setPaneProject(paneId, { cwd, name: folder, root: null });
  }
}

/**
 * Modelo y contexto de cada panel de Codex. Solo se escribe en el store si
 * algo cambió: el sondeo no re-renderiza la interfaz cada 3 s.
 */
async function pollCodex() {
  if (document.visibilityState !== "visible") return;
  const panes = state().tabs.flatMap((t) => collectPanes(t.root)).filter((p) => liveAgent(state(), p) === "codex");
  await Promise.all(
    panes.map(async (pane) => {
      const status = await terminalManager.codexStatus(pane.id);
      if (!status) return;
      const current = state().agentStatus[pane.id];
      if (current?.model === status.model && current?.contextPercent === status.contextPercent) return;
      state().setAgentStatus(status);
    }),
  );
}

/** Puertos de todos los paneles y sus shells acopladas, solo con la ventana a la vista. */
async function pollPorts() {
  if (document.visibilityState !== "visible") return;
  const panes = state().tabs.flatMap((t) => collectPanes(t.root));
  const ids = [...panes.map((p) => p.id), ...panes.flatMap((p) => (p.drawer ? [p.drawer.id] : []))];
  state().setPanePorts(await terminalManager.ports(ids));
}

/** La atención se considera vista cuando el panel está al frente y la ventana enfocada. */
function clearSeenAttention() {
  const { tabs, activeTabId, attention } = state();
  const paneId = tabs.find((t) => t.id === activeTabId)?.activePaneId;
  if (paneId && paneId in attention && document.hasFocus()) state().setAttention(paneId, null);
}

/**
 * `isMainWindow`: la bandeja de aprobaciones vive solo en la ventana principal.
 * La terminal rápida no conoce esos paneles: si escuchara, devolvería cada
 * solicitud a su panel en carrera con la principal.
 */
export function startBridge({ isMainWindow }: { isMainWindow: boolean }): () => void {
  terminalManager.setStoreHooks({
    isBroadcastEnabled: () => state().isBroadcastEnabled,
    // `exit` en la shell acoplada cierra solo esa shell, no el agente.
    onExit: (paneId) => {
      const owner = findDrawerOwner(state().tabs, paneId);
      if (owner) state().closeDrawer(owner.id);
      else state().closePane(paneId);
    },
    onTitle: (paneId, title) => {
      const clean = cleanTitle(title);
      if (clean) state().updatePaneTitle(paneId, clean);
    },
    onAttention: raiseAttention,
    onCommandFinished,
    onCwd: (paneId, cwd) => {
      void resolveProject(paneId, cwd);
      // Carpetas recientes de la barra lateral (la terminal rápida no las guarda).
      if (isMainWindow) useSidebarStore.getState().visit(cwd, terminalManager.getHome());
      if (!integrated.has(paneId)) {
        integrated.add(paneId);
        if (IS_TAURI) void logInfo(`[webview] integración con la shell activa (${paneId.slice(0, 12)}…, ${cwd})`).catch(() => {});
      }
      // La carpeta cambió (cd): el panel de proyecto se re-sincroniza ya, sin esperar al sondeo.
      const { tabs, activeTabId } = state();
      if (tabs.find((t) => t.id === activeTabId)?.activePaneId === paneId) {
        void import("./project").then(({ syncNow }) => syncNow());
      }
    },
    onOpenPath: (target) => void openPath(target),
    onProgramStatus,
    onPrompt,
    onCommandStart,
  });

  // Títulos visibles → registro del MCP (para que el agente reconozca "el panel del servidor").
  const sentTitles = new Map<string, string>();
  const pushTitles = () => {
    for (const tab of state().tabs) {
      for (const pane of collectPanes(tab.root)) {
        const title = tab.customTitle && tab.activePaneId === pane.id ? `${tab.customTitle} · ${pane.title}` : pane.title;
        if (sentTitles.get(pane.id) !== title) {
          sentTitles.set(pane.id, title);
          void ipc.paneSetTitle(pane.id, title);
        }
      }
    }
  };
  const unsubscribeStore = useTerminalStore.subscribe((s, prev) => {
    if (s.activeTabId !== prev.activeTabId || s.tabs !== prev.tabs) clearSeenAttention();
    if (s.tabs !== prev.tabs) pushTitles();
  });
  // El registro del backend existe cuando el PTY arranca: reintento corto al inicio.
  [1500, 4000].forEach((ms) => setTimeout(() => (sentTitles.clear(), pushTitles()), ms));
  window.addEventListener("focus", clearSeenAttention);

  const unlisteners = [
    ipc.onUsage((usage) => state().setUsage(usage)),
    ipc.onAgentStatus((status) => state().setAgentStatus(status)),
    ipc.onAgentAttention(({ paneId, kind, message }) => {
      // El turno terminó (hook Stop): si es de una carrera, el juez corre aunque estés mirando ese panel.
      if (kind === "done") onAgentDone(paneId);
      if (!reportsByOsc(paneId)) raiseAttention(paneId, kind, message);
    }),
    ipc.onAgentActivity((activity) => {
      if (reportsByOsc(activity.paneId)) return;
      state().setAgentActivity({ ...activity, source: "hook" });
      if (activity.state !== "needs-input") settleNeedsInput(activity.paneId);
    }),
    ipc.onAgentSession(({ paneId, sessionId, prompt, at }) =>
      state().setAgentSession(paneId, { id: sessionId, prompt: prompt ?? undefined, at }),
    ),
  ];

  void ipc.usageGet().then((usage) => usage && state().setUsage(usage));
  void ipc.agentsInfo().then((agents) => agents && state().setAgents(agents));
  void ipc.shells().then((shells) => shells && state().setShells(shells));
  if (isMainWindow) void ipc.sshHosts().then((hosts) => hosts && useSidebarStore.getState().setSshHosts(hosts));
  const stopApprovals = isMainWindow ? startApprovals({ isLookingAt, raiseAttention }) : () => {};
  const codexTimer = IS_TAURI ? setInterval(() => void pollCodex(), CODEX_POLL_MS) : undefined;
  const portsTimer = IS_TAURI && isMainWindow ? setInterval(() => void pollPorts(), PORTS_POLL_MS) : undefined;

  return () => {
    clearInterval(codexTimer);
    clearInterval(portsTimer);
    stopApprovals();
    unsubscribeStore();
    window.removeEventListener("focus", clearSeenAttention);
    unlisteners.forEach((p) => void p.then((unlisten) => unlisten()));
  };
}
