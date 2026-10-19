import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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
    console.warn("[termCode] No se pudo precargar la fuente del terminal:", err);
  }
}

const rootElement = document.getElementById("root");
if (rootElement) {
  void waitForTerminalFont().then(() => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
}
