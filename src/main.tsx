import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QuickApp } from "./QuickApp";
import { loadSettings, startSettingsSync } from "./lib/settings";
import { startUpdateChecks } from "./lib/updates";
import { useTerminalStore } from "./store/terminalStore";
import { useProjectStore } from "./store/projectStore";
import { startBridge } from "./lib/bridge";
import { IS_MAC, IS_WINDOWS } from "./lib/shortcuts";
import { startProjectTracking } from "./lib/project";
import { loadSession, startAutosave } from "./lib/persistence";
import { loadSidebar, startSidebarAutosave } from "./lib/sidebar";
import { loadBuffers, startBufferAutosave } from "./lib/buffers";
import { IS_TAURI } from "./lib/ipc";
import { invoke } from "@tauri-apps/api/core";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

/**
 * xterm mide el ancho de celda al abrir el terminal. Si la fuente aún no cargó,
 * mide con la de respaldo y la rejilla queda descuadrada. Esperamos (con tope).
 */
async function waitForTerminalFont(timeoutMs = 1500): Promise<void> {
  try {
    await Promise.race([
      document.fonts.load('13px "JetBrains Mono Variable"'),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (err) {
    console.warn("[termCode] no se pudo precargar la fuente del terminal:", err);
  }
}

/** Errores del webview al archivo de log (si no, un fallo de UI en producción es invisible). */
function forwardErrorsToLog() {
  if (!IS_TAURI) return;
  const report = (what: string) => void logError(`[webview] ${what}`).catch(() => {});
  window.addEventListener("error", (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => report(`promesa rechazada: ${String(e.reason)}`));
  window.addEventListener("securitypolicyviolation", (e) => report(`CSP bloqueó ${e.blockedURI} (${e.violatedDirective})`));
}

async function windowLabel(): Promise<string> {
  if (!IS_TAURI) return "main";
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

/**
 * La ventana principal tiene material detrás: vibrancy en macOS y Mica en
 * Windows 11 (build 22000+), ambos en tauri.conf. Windows 10 no tiene Mica.
 */
async function hasWindowMaterial(isQuick: boolean): Promise<boolean> {
  if (!IS_TAURI || isQuick) return false;
  if (IS_MAC) return true;
  if (!IS_WINDOWS) return false;
  const build = await invoke<number | null>("windows_build").catch(() => null);
  return (build ?? 0) >= 22000;
}

async function boot(root: HTMLElement) {
  forwardErrorsToLog();
  const isQuick = (await windowLabel()) === "quick";
  // Ajustes y sesión antes del primer render: sin parpadeo de tema y sin PTYs
  // que arrancan en una carpeta equivocada para luego ser reemplazados.
  const [session] = await Promise.all([
    isQuick ? Promise.resolve(null) : loadSession(),
    loadSettings(),
    waitForTerminalFont(),
    isQuick ? Promise.resolve() : loadSidebar(),
  ]);
  if (session) useTerminalStore.getState().hydrate(session);
  if (session?.isProjectOpen !== undefined) useProjectStore.getState().set({ isOpen: session.isProjectOpen });
  // Antes del primer render: los paneles restaurados se pintan con lo que tenían.
  if (session) await loadBuffers();

  // Glass real solo donde hay material detrás. En el resto, o con "reducir
  // transparencia" (macOS) / "efectos de transparencia" apagados (Windows), Neón
  // se pinta opaco.
  if (await hasWindowMaterial(isQuick)) {
    const reduced = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const sync = () => {
      if (reduced.matches) delete document.documentElement.dataset.glass;
      else document.documentElement.dataset.glass = "on";
    };
    sync();
    reduced.addEventListener("change", sync);
  }
  startSettingsSync({ isMainWindow: !isQuick });
  startBridge({ isMainWindow: !isQuick });
  if (!isQuick) {
    startAutosave();
    startSidebarAutosave();
    startBufferAutosave();
    startProjectTracking();
    startUpdateChecks();
  }

  ReactDOM.createRoot(root).render(<React.StrictMode>{isQuick ? <QuickApp /> : <App />}</React.StrictMode>);
  if (IS_TAURI) {
    const { tabs } = useTerminalStore.getState();
    void logInfo(`[webview] listo${isQuick ? " (terminal rápida)" : ""}: ${tabs.length} pestaña(s)${session ? " restauradas" : ""}`).catch(() => {});
  }
}

const rootElement = document.getElementById("root");
if (rootElement) void boot(rootElement);
