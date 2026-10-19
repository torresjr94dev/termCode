import React, { useCallback, useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { SplitView } from "./components/SplitView";
import { UsagePopover } from "./components/UsagePopover";
import { CommandPalette } from "./components/CommandPalette";
import { StatusBar } from "./components/StatusBar";
import { ConfirmDialog, ToastHost } from "./components/Overlays";
import { ProjectPanel } from "./components/project/ProjectPanel";
import { Viewer } from "./components/project/Viewer";
import { PrDialog } from "./components/project/PrDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { MissionControl } from "./components/MissionControl";
import { useTerminalStore } from "./store/terminalStore";
import { useUiStore } from "./store/uiStore";
import { terminalManager } from "./terminal/TerminalManager";
import { actions } from "./lib/actions";
import { openProject } from "./lib/project";
import { IS_TAURI, shellQuote } from "./lib/ipc";
import { collectPanes } from "./lib/layout";
import { matchShortcut, matchTabIndex, type ShortcutId } from "./lib/shortcuts";

const SHORTCUT_HANDLERS: Record<Exclude<ShortcutId, "palette">, () => unknown> = {
  newTab: actions.newTab,
  closePane: () => actions.closePane(),
  splitRight: actions.splitRight,
  splitDown: actions.splitDown,
  nextPane: () => actions.focusPaneOffset(1),
  prevPane: () => actions.focusPaneOffset(-1),
  toggleSidebar: actions.toggleSidebar,
  toggleUsage: actions.toggleUsage,
  toggleBroadcast: actions.toggleBroadcast,
  find: actions.toggleFind,
  fontBigger: actions.fontBigger,
  fontSmaller: actions.fontSmaller,
  fontReset: actions.fontReset,
  projectFiles: () => openProject("files"),
  projectChanges: () => openProject("changes"),
  prevCommand: () => actions.jumpCommand(-1),
  nextCommand: () => actions.jumpCommand(1),
  zoomPane: actions.toggleZoom,
  reopenClosed: actions.reopenClosed,
  settings: actions.openSettings,
  overview: () => useUiStore.getState().setOverviewOpen(!useUiStore.getState().isOverviewOpen),
  missionControl: () => useUiStore.getState().setMissionOpen(!useUiStore.getState().isMissionOpen),
};

function focusActivePane() {
  const { tabs, activeTabId } = useTerminalStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab) terminalManager.focus(tab.activePaneId);
}

/** Panel bajo un punto de la ventana (coordenadas CSS). */
function paneAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null;
}

/**
 * Arrastrar archivos sobre un panel pega sus rutas escapadas (p. ej. una
 * captura de pantalla directo a Claude Code).
 */
function useFileDrop() {
  useEffect(() => {
    if (!IS_TAURI) return;
    const setDropPane = useUiStore.getState().setDropPane;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setDropPane(null);
          return;
        }
        const scale = window.devicePixelRatio || 1;
        const paneId = paneAt(payload.position.x / scale, payload.position.y / scale);
        if (payload.type === "drop") {
          setDropPane(null);
          if (!paneId || !payload.paths.length) return;
          terminalManager.paste(paneId, `${payload.paths.map(shellQuote).join(" ")} `);
          useTerminalStore.getState().setActivePane(paneId);
        } else {
          setDropPane(paneId);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn("[termCode] drag & drop no disponible:", err));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

export const App: React.FC = () => {
  const isPaletteOpen = useUiStore((s) => s.isPaletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isBroadcastEnabled = useTerminalStore((s) => s.isBroadcastEnabled);

  useFileDrop();

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    focusActivePane();
  }, [setPaletteOpen]);

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

      const ui = useUiStore.getState();
      if (shortcut === "palette") {
        ui.setPaletteOpen(!ui.isPaletteOpen);
        if (ui.isPaletteOpen) focusActivePane();
        return;
      }
      // Con la paleta o un diálogo abiertos, el resto de atajos no debe actuar a ciegas.
      if (ui.isPaletteOpen || ui.confirm || ui.isSettingsOpen) return;
      if (ui.isMissionOpen && shortcut !== "missionControl") return;

      if (shortcut === "toggleUsage" && useTerminalStore.getState().isUsageDrawerOpen) closeUsage();
      else if (shortcut) void SHORTCUT_HANDLERS[shortcut]();
      else if (tabIndex !== null) actions.goToTab(tabIndex);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [closeUsage]);

  // Al cambiar de pestaña: foco al panel activo y WebGL solo donde se ve.
  // (El ResizeObserver de cada panel se encarga del fit al volverse visible.)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const active = useTerminalStore.getState().tabs.find((t) => t.id === activeTabId);
      terminalManager.syncRenderers(new Set(active ? collectPanes(active.root).map((p) => p.id) : []));
      focusActivePane();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTabId, tabs.length]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas text-ink">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenPalette={() => setPaletteOpen(true)} />

        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1 bg-canvas">
            {tabs.map((tab) => (
              <div key={tab.id} hidden={tab.id !== activeTabId} className="absolute inset-0">
                <SplitView node={tab.root} activePaneId={tab.activePaneId} zoomedPaneId={tab.zoomedPaneId} />
              </div>
            ))}
            {/* Broadcast es peligroso: el marco rojo no se puede pasar por alto */}
            {isBroadcastEnabled && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-20 shadow-[inset_0_0_0_1px_var(--color-signal)]"
              />
            )}
            {/* Diffs y vistas previas se abren sobre las terminales; el panel queda a mano */}
            <Viewer />
          </main>
          <ProjectPanel />
        </div>

        <StatusBar />
      </div>

      <UsagePopover onClose={closeUsage} />
      <CommandPalette isOpen={isPaletteOpen} onClose={closePalette} />
      <PrDialog />
      <SettingsDialog onClosed={focusActivePane} />
      <MissionControl onClosed={focusActivePane} />
      <ConfirmDialog onSettled={focusActivePane} />
      <ToastHost />
    </div>
  );
};

export default App;
