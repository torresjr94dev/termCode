import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentActivity, AgentAttention, AgentStatus, AgentsInfo, UsageSnapshot } from "../types/layout";

/** `false` en un navegador normal (p. ej. el harness de pruebas): todo se vuelve no-op. */
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    console.warn(`[termCode] ${command} falló:`, err);
    return null;
  }
}

async function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!IS_TAURI) return () => {};
  try {
    return await listen<T>(event, (e) => handler(e.payload));
  } catch (err) {
    console.warn(`[termCode] no se pudo escuchar ${event}:`, err);
    return () => {};
  }
}

export const ipc = {
  usageGet: () => call<UsageSnapshot>("usage_get"),
  usageRefresh: () => call<void>("usage_refresh"),
  agentsInfo: () => call<AgentsInfo>("agents_info"),

  /** Lanza un error legible: el llamador lo muestra al usuario. */
  async worktreeCreate(cwd: string, label: string): Promise<string> {
    if (!IS_TAURI) throw new Error("Solo disponible en la app de escritorio.");
    return invoke<string>("git_worktree_create", { cwd, label });
  },

  /** Abre un archivo en el editor configurado (lanza un error legible si no hay). */
  async openInEditor(path: string, line: number | null, editor: string): Promise<void> {
    if (!IS_TAURI) throw new Error("Solo disponible en la app de escritorio.");
    await invoke("open_in_editor", { path, line, column: null, editor });
  },

  onUsage: (handler: (snapshot: UsageSnapshot) => void) => on("usage-updated", handler),
  onAgentStatus: (handler: (status: AgentStatus) => void) => on("agent-status", handler),
  onAgentAttention: (handler: (attention: AgentAttention) => void) => on("agent-attention", handler),
  onAgentActivity: (handler: (activity: AgentActivity) => void) => on("agent-activity", handler),
  paneSetTitle: (paneId: string, title: string) => call<void>("pane_set_title", { paneId, title }),
  setUnsaved: (unsaved: boolean) => call<void>("editor_set_unsaved", { unsaved }),
  quitApp: () => call<void>("app_quit"),
  onQuitRequested: (handler: () => void) => on<null>("quit-requested", handler),
};

/** Comillas POSIX: rutas con espacios o comillas llegan intactas a la shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
