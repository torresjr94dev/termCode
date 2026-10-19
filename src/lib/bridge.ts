import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useTerminalStore } from "../store/terminalStore";
import { terminalManager } from "../terminal/TerminalManager";
import { findOwnerTab, findPane } from "./layout";
import { IS_TAURI, ipc } from "./ipc";

const state = () => useTerminalStore.getState();

let notificationsAllowed: boolean | null = null;

async function notify(title: string, body: string) {
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

/** La atención se considera vista cuando el panel está al frente y la ventana enfocada. */
function clearSeenAttention() {
  const { tabs, activeTabId, attention } = state();
  const paneId = tabs.find((t) => t.id === activeTabId)?.activePaneId;
  if (paneId && paneId in attention && document.hasFocus()) state().setAttention(paneId, null);
}

export function startBridge(): () => void {
  terminalManager.setStoreHooks({
    isBroadcastEnabled: () => state().isBroadcastEnabled,
    onExit: (paneId) => state().closePane(paneId),
    onTitle: (paneId, title) => {
      const trimmed = title.trim();
      if (trimmed) state().updatePaneTitle(paneId, trimmed);
    },
    onAttention: raiseAttention,
  });

  const unsubscribeStore = useTerminalStore.subscribe((s, prev) => {
    if (s.activeTabId !== prev.activeTabId || s.tabs !== prev.tabs) clearSeenAttention();
  });
  window.addEventListener("focus", clearSeenAttention);

  const unlisteners = [
    ipc.onUsage((usage) => state().setUsage(usage)),
    ipc.onAgentStatus((status) => state().setAgentStatus(status)),
    ipc.onAgentAttention(({ paneId, kind, message }) => raiseAttention(paneId, kind, message)),
  ];

  void ipc.usageGet().then((usage) => usage && state().setUsage(usage));
  void ipc.agentsInfo().then((agents) => agents && state().setAgents(agents));

  return () => {
    unsubscribeStore();
    window.removeEventListener("focus", clearSeenAttention);
    unlisteners.forEach((p) => void p.then((unlisten) => unlisten()));
  };
}
