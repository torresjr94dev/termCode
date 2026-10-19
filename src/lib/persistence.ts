import { LazyStore } from "@tauri-apps/plugin-store";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { useTerminalStore, type PersistedSession } from "../store/terminalStore";
import { terminalManager } from "../terminal/TerminalManager";
import type { LayoutNode, Tab } from "../types/layout";
import { basename } from "./layout";
import { IS_TAURI } from "./ipc";

const KEY = "session";
const SAVE_DEBOUNCE_MS = 1500;
/** El cwd cambia sin que el layout cambie: se re-guarda periódicamente. */
const SAVE_EVERY_MS = 20_000;

const store = IS_TAURI ? new LazyStore("session.json", { defaults: {}, autoSave: false }) : null;

function isTab(value: unknown): value is Tab {
  const tab = value as Tab;
  return typeof tab?.id === "string" && typeof tab.activePaneId === "string" && isNode(tab.root);
}

function isNode(value: unknown): value is LayoutNode {
  const node = value as LayoutNode;
  if (!node || typeof node.id !== "string") return false;
  if (node.type === "pane") return typeof node.title === "string";
  return (
    node.type === "split" &&
    (node.direction === "horizontal" || node.direction === "vertical") &&
    typeof node.ratio === "number" &&
    isNode(node.first) &&
    isNode(node.second)
  );
}

/**
 * Los agentes no se relanzan solos (gastarían cuota sin que lo pidas):
 * vuelven como shells en la misma carpeta.
 */
function asShells(node: LayoutNode): LayoutNode {
  if (node.type === "split") return { ...node, first: asShells(node.first), second: asShells(node.second) };
  if (!node.agentType && !node.command) return node;
  return {
    ...node,
    title: node.cwd ? basename(node.cwd) : "zsh",
    command: undefined,
    agentType: null,
  };
}

export async function loadSession(timeoutMs = 800): Promise<PersistedSession | null> {
  if (!store) return null;
  try {
    const saved = await Promise.race([
      store.get<PersistedSession>(KEY),
      new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.tabs)) return null;
    const tabs = saved.tabs.filter(isTab).map((tab) => ({ ...tab, root: asShells(tab.root), zoomedPaneId: null }));
    if (!tabs.length) return null;
    return { version: 1, tabs, activeTabId: saved.activeTabId, isSidebarOpen: Boolean(saved.isSidebarOpen) };
  } catch (err) {
    console.warn("[termCode] no se pudo leer la sesión guardada:", err);
    return null;
  }
}

async function withLiveCwd(node: LayoutNode): Promise<LayoutNode> {
  if (node.type === "split") {
    const [first, second] = await Promise.all([withLiveCwd(node.first), withLiveCwd(node.second)]);
    return { ...node, first, second };
  }
  const info = await terminalManager.info(node.id);
  return info?.cwd ? { ...node, cwd: info.cwd } : node;
}

async function save() {
  if (!store) return;
  const { tabs, activeTabId, isSidebarOpen } = useTerminalStore.getState();
  try {
    const session: PersistedSession = {
      version: 1,
      tabs: await Promise.all(tabs.map(async (tab) => ({ ...tab, root: await withLiveCwd(tab.root) }))),
      activeTabId,
      isSidebarOpen,
    };
    await store.set(KEY, session);
    await store.save();
  } catch (err) {
    void logWarn(`[webview] no se pudo guardar la sesión: ${String(err)}`).catch(() => {});
  }
}

export function startAutosave(): () => void {
  if (!store) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  };
  const unsubscribe = useTerminalStore.subscribe((s, prev) => {
    if (
      s.tabs !== prev.tabs ||
      s.activeTabId !== prev.activeTabId ||
      s.isSidebarOpen !== prev.isSidebarOpen
    ) {
      schedule();
    }
  });
  const interval = setInterval(() => void save(), SAVE_EVERY_MS);
  // Primer guardado poco después de arrancar: los PTY ya tienen cwd real.
  const initial = setTimeout(() => void save(), 3000);
  return () => {
    clearTimeout(initial);
    unsubscribe();
    clearTimeout(timer);
    clearInterval(interval);
  };
}
