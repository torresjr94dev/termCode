import React, { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TerminalPane } from "./components/TerminalPane";
import { ToastHost } from "./components/Overlays";
import { useTerminalStore } from "./store/terminalStore";
import { settingsNow } from "./store/settingsStore";
import { terminalManager } from "./terminal/TerminalManager";
import { IS_TAURI } from "./lib/ipc";
import { shortcutLabel } from "./lib/shortcuts";

/**
 * Terminal rápida: un solo panel a todo lo ancho, sin pestañas ni paneles.
 * El mismo atajo global la muestra y la oculta; también se oculta al perder
 * el foco si así está configurado.
 */
export const QuickApp: React.FC = () => {
  const pane = useTerminalStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.root.type === "pane" ? tab.root : null;
  });

  useEffect(() => {
    if (!IS_TAURI) return;
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        const id = useTerminalStore.getState().tabs[0]?.activePaneId;
        if (id) terminalManager.focus(id);
      } else if (settingsNow().quickHideOnBlur) {
        void invoke("quick_hide").catch(() => {});
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="relative min-h-0 flex-1">{pane && <TerminalPane key={pane.id} pane={pane} isActive isSplit={false} />}</div>
      <div className="flex h-6 shrink-0 items-center justify-between border-t border-accent/40 bg-chrome px-3 font-mono text-[11px] text-ink-3">
        <span>termCode · terminal rápida</span>
        <span>{settingsNow().quickShortcut.replace(/\+/g, " ")} para ocultar · {shortcutLabel("palette")} solo en la ventana principal</span>
      </div>
      <ToastHost />
    </div>
  );
};
