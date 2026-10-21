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
import { FileFinder } from "./components/FileFinder";
import { Overview } from "./components/Overview";
import { ShortcutHints } from "./components/ShortcutHints";
import { Welcome } from "./components/Welcome";
import { ApprovalTray } from "./components/ApprovalTray";
import { useTerminalStore } from "./store/terminalStore";
import { useUiStore } from "./store/uiStore";
import { settingsNow } from "./store/settingsStore";
import { terminalManager } from "./terminal/TerminalManager";
import { actions } from "./lib/actions";
import { closeViewer, hasUnsavedEdits, openBranchPicker, openProject } from "./lib/project";
import { ipc } from "./lib/ipc";
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
  fileFinder: () => useUiStore.getState().setFinderOpen(!useUiStore.getState().isFinderOpen),
  switchBranch: openBranchPicker,
  nextAttention: actions.focusNextAttention,
};

const EDITOR_OWNED = new Set<ShortcutId>(["find", "splitRight", "prevCommand", "nextCommand"]);

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

/** Cerrar la ventana o salir con un archivo sin guardar: se pregunta antes. */
function useQuitGuard() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void ipc
      .onQuitRequested(() => {
        if (!hasUnsavedEdits()) {
          void ipc.quitApp();
          return;
        }
        useUiStore.getState().askConfirm({
          title: "¿Salir sin guardar?",
          body: "Hay un archivo con cambios sin guardar en el visor. Si sales ahora, se pierden.",
          confirmLabel: "Salir sin guardar",
          onConfirm: () => void ipc.quitApp(),
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
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
  useQuitGuard();

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

      // En el editor de archivos, estos acordes son del editor (buscar, siguiente
      // coincidencia, inicio/fin del documento), no de la terminal de atrás.
      const target = e.target instanceof Element ? e.target : null;
      if (shortcut && EDITOR_OWNED.has(shortcut) && target?.closest(".cm-editor")) return;

      e.preventDefault();
      e.stopPropagation();

      const ui = useUiStore.getState();
      if (shortcut === "palette") {
        ui.setPaletteOpen(!ui.isPaletteOpen);
        if (ui.isPaletteOpen) focusActivePane();
        return;
      }
      // Con la paleta o un diálogo abiertos, el resto de atajos no debe actuar a ciegas.
      if (ui.isPaletteOpen || ui.confirm || ui.isSettingsOpen || !settingsNow().onboardingDone) return;
      if (ui.isFinderOpen && shortcut !== "fileFinder") return;
      if (ui.isOverviewOpen && shortcut !== "overview") return;
      if (ui.isMissionOpen && shortcut !== "missionControl") return;

      // ⌘W con un archivo abierto cierra el archivo, no el panel que está debajo.
      if (shortcut === "closePane" && target?.closest("[data-viewer]")) closeViewer();
      else if (shortcut === "toggleUsage" && useTerminalStore.getState().isUsageDrawerOpen) closeUsage();
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
    <div className="flex h-full w-full overflow-hidden bg-window text-ink">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenPalette={() => setPaletteOpen(true)} />

        {/* Las tarjetas (terminales, visor, proyecto) flotan sobre el vidrio con 8 px de aire. */}
        <div className="flex min-h-0 flex-1 gap-2 px-2">
          {/* Sin fondo propio: cada panel pinta el suyo (con glass, un solo velo sobre el escritorio). */}
          <main className="relative min-w-0 flex-1">
            {tabs.map((tab) => (
              <div key={tab.id} hidden={tab.id !== activeTabId} className="absolute inset-0">
                <SplitView node={tab.root} activePaneId={tab.activePaneId} zoomedPaneId={tab.zoomedPaneId} />
              </div>
            ))}
            {/* Broadcast es peligroso: el marco rojo no se puede pasar por alto */}
            {isBroadcastEnabled && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-20 rounded-xl shadow-[inset_0_0_0_1.5px_var(--color-signal)]"
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
      <FileFinder onClosed={focusActivePane} />
      <Overview onClosed={focusActivePane} />
      <ShortcutHints />
      <Welcome onClosed={focusActivePane} />
      <ApprovalTray />
      <ConfirmDialog onSettled={focusActivePane} />
      <ToastHost />
    </div>
  );
};

export default App;
