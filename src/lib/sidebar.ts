import { LazyStore } from "@tauri-apps/plugin-store";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { useSidebarStore, type SidebarData } from "../store/sidebarStore";
import { IS_TAURI } from "./ipc";

const KEY = "sidebar";
const SAVE_DEBOUNCE_MS = 1000;

const store = IS_TAURI ? new LazyStore("sidebar.json", { defaults: {}, autoSave: false }) : null;

/** Carpetas y secciones plegadas de la última vez (con tope de espera: nunca bloquea el arranque). */
export async function loadSidebar(timeoutMs = 600): Promise<void> {
  if (!store) return;
  try {
    const saved = await Promise.race([
      store.get<SidebarData>(KEY),
      new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (saved) useSidebarStore.getState().hydrate(saved);
  } catch (err) {
    console.warn("[termCode] no se pudo leer la barra lateral guardada:", err);
  }
}

/** Guarda al cambiar algo (agrupado: un `cd` tras otro no escribe cada vez). */
export function startSidebarAutosave(): () => void {
  if (!store) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = async () => {
    const { recent, pinned, collapsed, servers, trustedWorkspaces } = useSidebarStore.getState();
    try {
      await store.set(KEY, { recent, pinned, collapsed, servers, trustedWorkspaces } satisfies SidebarData);
      await store.save();
    } catch (err) {
      void logWarn(`[webview] no se pudo guardar la barra lateral: ${String(err)}`).catch(() => {});
    }
  };
  const unsubscribe = useSidebarStore.subscribe((s, prev) => {
    if (
      s.recent === prev.recent &&
      s.pinned === prev.pinned &&
      s.collapsed === prev.collapsed &&
      s.servers === prev.servers &&
      s.trustedWorkspaces === prev.trustedWorkspaces
    ) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
