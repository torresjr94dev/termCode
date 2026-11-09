import { useUiStore, type FinderMode } from "../store/uiStore";
import { useTerminalStore } from "../store/terminalStore";
import { terminalManager } from "../terminal/TerminalManager";

/** Lo seleccionado en la terminal activa, si sirve para buscar (una línea corta). */
function selectionToSearch(): string | undefined {
  const { tabs, activeTabId } = useTerminalStore.getState();
  const paneId = tabs.find((t) => t.id === activeTabId)?.activePaneId;
  const text = (paneId ? terminalManager.getSelection(paneId) : "") || (window.getSelection()?.toString() ?? "");
  const line = text.trim();
  return line && !line.includes("\n") && line.length <= 200 ? line : undefined;
}

/** ⌘P / ⌘⇧F: abre el buscador en ese modo, o lo cierra si ya estaba en él. */
export function toggleFinder(mode: FinderMode) {
  const ui = useUiStore.getState();
  if (ui.finder?.mode === mode) {
    ui.closeFinder();
    return;
  }
  ui.openFinder({ mode, query: mode === "text" ? selectionToSearch() : undefined });
}

/** Abre el buscador en ese modo (botones y caja de búsqueda: nunca lo cierran). */
export function openFinder(mode: FinderMode) {
  useUiStore.getState().openFinder({ mode, query: mode === "text" ? selectionToSearch() : undefined });
}

/** Buscar dentro de una carpeta del proyecto (menú del árbol). */
export function searchInFolder(dir: string, mode: FinderMode = "text") {
  useUiStore.getState().openFinder({ mode, dir });
}
