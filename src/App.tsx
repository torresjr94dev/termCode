import React, { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { SplitView } from "./components/SplitView";
import { UsagePopover } from "./components/UsagePopover";
import { CommandPalette } from "./components/CommandPalette";
import { StatusBar } from "./components/StatusBar";
import { useTerminalStore } from "./store/terminalStore";
import { terminalManager } from "./terminal/TerminalManager";
import { actions } from "./lib/actions";
import { matchShortcut, matchTabIndex, type ShortcutId } from "./lib/shortcuts";

const SHORTCUT_HANDLERS: Record<Exclude<ShortcutId, "palette">, () => void> = {
  newTab: actions.newTab,
  closePane: actions.closePane,
  splitRight: actions.splitRight,
  splitDown: actions.splitDown,
  nextPane: () => actions.focusPaneOffset(1),
  prevPane: () => actions.focusPaneOffset(-1),
  toggleSidebar: actions.toggleSidebar,
  toggleUsage: actions.toggleUsage,
  toggleBroadcast: actions.toggleBroadcast,
};

function focusActivePane() {
  const { tabs, activeTabId } = useTerminalStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab) terminalManager.focus(tab.activePaneId);
}

export const App: React.FC = () => {
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(isPaletteOpen);
  paletteOpenRef.current = isPaletteOpen;

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isBroadcastEnabled = useTerminalStore((s) => s.isBroadcastEnabled);

  const closePalette = useCallback(() => {
    setIsPaletteOpen(false);
    focusActivePane();
  }, []);

  const closeUsage = useCallback(() => {
    if (useTerminalStore.getState().isUsageDrawerOpen) actions.toggleUsage();
    focusActivePane();
  }, []);

  // Fase de captura: el atajo se consume antes de que xterm lo envíe al PTY.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const shortcut = matchShortcut(e);
      const tabIndex = shortcut ? null : matchTabIndex(e);
      if (!shortcut && tabIndex === null) return;

      e.preventDefault();
      e.stopPropagation();

      if (shortcut === "palette") {
        setIsPaletteOpen((open) => !open);
        if (paletteOpenRef.current) focusActivePane();
        return;
      }
      // Con la paleta abierta, el resto de atajos no debe actuar a ciegas.
      if (paletteOpenRef.current) return;

      if (shortcut === "toggleUsage" && useTerminalStore.getState().isUsageDrawerOpen) closeUsage();
      else if (shortcut) SHORTCUT_HANDLERS[shortcut]();
      else if (tabIndex !== null) actions.goToTab(tabIndex);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [closeUsage]);

  // Al cambiar de pestaña, el foco va al panel activo de la nueva pestaña.
  // (El ResizeObserver de cada panel se encarga del fit al volverse visible.)
  useEffect(() => {
    const frame = requestAnimationFrame(focusActivePane);
    return () => cancelAnimationFrame(frame);
  }, [activeTabId]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas text-ink">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenPalette={() => setIsPaletteOpen(true)} />

        <main className="relative min-h-0 flex-1 bg-canvas">
          {tabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeTabId} className="absolute inset-0">
              <SplitView node={tab.root} activePaneId={tab.activePaneId} />
            </div>
          ))}
          {/* Broadcast es peligroso: el marco rojo no se puede pasar por alto */}
          {isBroadcastEnabled && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 shadow-[inset_0_0_0_1px_var(--color-signal)]" />
          )}
        </main>

        <StatusBar />
      </div>

      <UsagePopover onClose={closeUsage} />
      <CommandPalette isOpen={isPaletteOpen} onClose={closePalette} />
    </div>
  );
};

export default App;
