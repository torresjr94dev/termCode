import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { settingsNow } from "../store/settingsStore";
import { terminalManager } from "../terminal/TerminalManager";
import type { CommandRecord } from "../terminal/commands";
import type { FileLinkTarget } from "../terminal/links";
import { collectPanes, findOwnerTab, findPane } from "./layout";
import { IS_TAURI, ipc } from "./ipc";
import { formatDuration } from "./format";
import { startApprovals } from "./approvals";
import { onAgentDone } from "./race";
import { renderWelcome } from "./welcome";
import { cleanTitle } from "./identity";
import { info as logInfo } from "@tauri-apps/plugin-log";
import { basename } from "./paths";

const state = () => useTerminalStore.getState();
/** Paneles que ya avisaron de su integración (una línea de log por panel). */
const integrated = new Set<string>();

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
    onExit: (paneId) => state().closePane(paneId),
    onTitle: (paneId, title) => {
      const clean = cleanTitle(title);
      if (clean) state().updatePaneTitle(paneId, clean);
    },
    onAttention: raiseAttention,
    onCommandFinished,
    onCwd: (paneId, cwd) => {
      void resolveProject(paneId, cwd);
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
    renderWelcome,
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
      // El turno terminó: si es de una carrera, el juez corre aunque estés mirando ese panel.
      if (kind === "done") onAgentDone(paneId);
      raiseAttention(paneId, kind, message);
    }),
    ipc.onAgentActivity((activity) => state().setAgentActivity(activity)),
    ipc.onAgentSession(({ paneId, sessionId, prompt, at }) =>
      state().setAgentSession(paneId, { id: sessionId, prompt: prompt ?? undefined, at }),
    ),
  ];

  void ipc.usageGet().then((usage) => usage && state().setUsage(usage));
  void ipc.agentsInfo().then((agents) => agents && state().setAgents(agents));
  const stopApprovals = isMainWindow ? startApprovals({ isLookingAt, raiseAttention }) : () => {};

  return () => {
    stopApprovals();
    unsubscribeStore();
    window.removeEventListener("focus", clearSeenAttention);
    unlisteners.forEach((p) => void p.then((unlisten) => unlisten()));
  };
}
