import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useTerminalStore } from "./store/terminalStore";
import { startBridge } from "./lib/bridge";
import { startProjectTracking } from "./lib/project";
import { loadSession, startAutosave } from "./lib/persistence";
import { IS_TAURI } from "./lib/ipc";
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

async function boot(root: HTMLElement) {
  forwardErrorsToLog();
  // La sesión se restaura antes del primer render: así ningún PTY arranca en
  // una carpeta equivocada para luego ser reemplazado.
  const [session] = await Promise.all([loadSession(), waitForTerminalFont()]);
  if (session) useTerminalStore.getState().hydrate(session);

  startBridge();
  startAutosave();
  startProjectTracking();

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  if (IS_TAURI) {
    const { tabs } = useTerminalStore.getState();
    void logInfo(`[webview] listo: ${tabs.length} pestaña(s)${session ? " restauradas" : ""}`).catch(() => {});
  }
}

const rootElement = document.getElementById("root");
if (rootElement) void boot(rootElement);
