import { LazyStore } from "@tauri-apps/plugin-store";
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";
import { sanitize, useSettingsStore, type Settings } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { IS_TAURI } from "./ipc";

const KEY = "settings";
const store = IS_TAURI ? new LazyStore("settings.json", { defaults: {}, autoSave: false }) : null;

/** Antes del primer render: así no hay parpadeo de tema ni de fuente. */
export async function loadSettings(timeoutMs = 600): Promise<void> {
  if (!store) return;
  try {
    const saved = await Promise.race([
      store.get<Settings>(KEY),
      new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (saved) useSettingsStore.getState().replace(sanitize(saved));
  } catch (err) {
    console.warn("[termCode] ajustes no disponibles, se usan los de fábrica:", err);
  }
}

function applyTheme(theme: Settings["theme"]) {
  if (theme === "fosforo") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

let registeredShortcut: string | null = null;

/** Atajo global de la terminal rápida (solo lo registra la ventana principal). */
async function syncQuickShortcut(settings: Settings) {
  if (!IS_TAURI) return;
  const wanted = settings.quickTerminal ? settings.quickShortcut : null;
  if (wanted === registeredShortcut) return;
  try {
    if (registeredShortcut) await unregister(registeredShortcut);
    registeredShortcut = null;
    if (wanted) {
      // Tras recargar el webview (⌘R, HMR) el registro nativo anterior sigue vivo
      // con un callback muerto: se suelta y se vuelve a registrar con este.
      if (await isRegistered(wanted)) await unregister(wanted);
      await register(wanted, (event) => {
        if (event.state === "Pressed") void invoke("quick_toggle").catch(() => {});
      });
      registeredShortcut = wanted;
      void logInfo(`[webview] atajo global de la terminal rápida: ${wanted}`).catch(() => {});
    }
  } catch (err) {
    // Suele ser un choque con otra app (Raycast, Alfred…) que ya usa ese atajo.
    void logWarn(`[webview] no se pudo registrar ${wanted}: ${String(err)}`).catch(() => {});
    useUiStore.getState().showToast(`No se pudo registrar el atajo ${wanted} (¿lo usa otra app?): ${String(err)}`, "error");
  }
}

/**
 * Aplica los ajustes (tema, terminales, atajo global) y los guarda con cada
 * cambio. En la ventana rápida escucha los cambios que se hagan en la principal.
 */
export function startSettingsSync({ isMainWindow }: { isMainWindow: boolean }): () => void {
  const apply = (settings: Settings) => {
    applyTheme(settings.theme);
    terminalManager.applySettings(settings);
    if (isMainWindow) void syncQuickShortcut(settings);
  };
  apply(useSettingsStore.getState().settings);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let applyingRemote = false;
  const unsubscribe = useSettingsStore.subscribe((s, prev) => {
    if (s.settings === prev.settings) return;
    apply(s.settings);
    if (!store || applyingRemote) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void store
        .set(KEY, s.settings)
        .then(() => store.save())
        .catch((err) => console.warn("[termCode] no se pudieron guardar los ajustes:", err));
    }, 300);
  });

  let unlistenRemote: (() => void) | undefined;
  if (store) {
    void store
      .onKeyChange<Settings>(KEY, (value) => {
        if (!value || JSON.stringify(value) === JSON.stringify(useSettingsStore.getState().settings)) return;
        applyingRemote = true;
        useSettingsStore.getState().replace(sanitize(value));
        applyingRemote = false;
      })
      .then((fn) => (unlistenRemote = fn))
      .catch(() => {});
  }

  return () => {
    clearTimeout(timer);
    unsubscribe();
    unlistenRemote?.();
  };
}
