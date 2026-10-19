import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentAttention, AgentStatus, AgentsInfo, UsageSnapshot } from "../types/layout";

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

  onUsage: (handler: (snapshot: UsageSnapshot) => void) => on("usage-updated", handler),
  onAgentStatus: (handler: (status: AgentStatus) => void) => on("agent-status", handler),
  onAgentAttention: (handler: (attention: AgentAttention) => void) => on("agent-attention", handler),
};

/** Comillas POSIX: rutas con espacios o comillas llegan intactas a la shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
