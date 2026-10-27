import { LazyStore } from "@tauri-apps/plugin-store";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { useTerminalStore, type PersistedSession } from "../store/terminalStore";
import { useProjectStore } from "../store/projectStore";
import { terminalManager } from "../terminal/TerminalManager";
import type { LayoutNode, PaneShell, ResumableAgent, Tab } from "../types/layout";
import { basename } from "./layout";
import { IS_TAURI } from "./ipc";
import { isSafeSessionId } from "./resume";

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

/** Lo que llega del disco puede venir editado a mano o de otra versión: solo pasa lo válido. */
export function sanitizeResumable(value: unknown): ResumableAgent | undefined {
  const r = value as Partial<ResumableAgent> | null;
  if (!r || (r.agent !== "claude" && r.agent !== "codex") || typeof r.title !== "string") return undefined;
  return {
    agent: r.agent,
    sessionId: typeof r.sessionId === "string" && isSafeSessionId(r.sessionId) ? r.sessionId : null,
    title: r.title.slice(0, 120),
    prompt: typeof r.prompt === "string" ? r.prompt.slice(0, 200) : undefined,
    at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : undefined,
  };
}

/** Una shell guardada solo vuelve si tiene forma de shell: ruta absoluta y argumentos de texto. */
export function sanitizeShell(value: unknown): PaneShell | undefined {
  const shell = value as Partial<PaneShell> | null;
  if (!shell || typeof shell.name !== "string" || typeof shell.path !== "string") return undefined;
  if (!/^(\/|[A-Za-z]:[\\/])/.test(shell.path) || shell.path.length > 4096) return undefined;
  const args = Array.isArray(shell.args) && shell.args.every((a) => typeof a === "string" && a.length < 256) ? shell.args.slice(0, 8) : [];
  return { name: shell.name.slice(0, 40), path: shell.path, args };
}

/**
 * Los agentes no se relanzan solos (gastarían cuota sin que lo pidas):
 * vuelven como shells en la misma carpeta, con lo necesario para reanudarlos
 * con un clic (`claude --resume`, `codex resume --last`).
 */
export function asShells(node: LayoutNode): LayoutNode {
  if (node.type === "split") return { ...node, first: asShells(node.first), second: asShells(node.second) };
  // La shell acoplada era del agente: al volver como shell, el panel ya es una terminal.
  const { agentSession, resumable, shell: savedShell, drawer: _drawer, ...rest } = node;
  const shell = sanitizeShell(savedShell);
  const pane = shell ? { ...rest, shell } : rest;
  if (!pane.agentType && !pane.command) {
    // Un aviso de reanudar que no se usó sigue ahí tras otro reinicio.
    const kept = sanitizeResumable(resumable);
    return kept ? { ...pane, resumable: kept } : pane;
  }
  const next: LayoutNode = {
    ...pane,
    title: pane.cwd ? basename(pane.cwd) : "zsh",
    command: undefined,
    agentType: null,
  };
  if (pane.agentType) {
    next.resumable = sanitizeResumable({
      agent: pane.agentType,
      sessionId: agentSession?.id ?? null,
      title: pane.title,
      prompt: agentSession?.prompt,
      at: agentSession?.at,
    });
  }
  return next;
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
    return {
      version: 1,
      tabs,
      activeTabId: saved.activeTabId,
      isSidebarOpen: Boolean(saved.isSidebarOpen),
      ...(typeof saved.isProjectOpen === "boolean" ? { isProjectOpen: saved.isProjectOpen } : {}),
    };
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
      isProjectOpen: useProjectStore.getState().isOpen,
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
  const unsubscribeProject = useProjectStore.subscribe((s, prev) => {
    if (s.isOpen !== prev.isOpen) schedule();
  });
  const interval = setInterval(() => void save(), SAVE_EVERY_MS);
  // Primer guardado poco después de arrancar: los PTY ya tienen cwd real.
  const initial = setTimeout(() => void save(), 3000);
  return () => {
    clearTimeout(initial);
    unsubscribe();
    unsubscribeProject();
    clearTimeout(timer);
    clearInterval(interval);
  };
}
