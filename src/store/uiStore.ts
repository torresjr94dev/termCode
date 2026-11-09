import { create } from "zustand";
import type { LucideIcon } from "lucide-react";
import type { DropZone } from "../lib/layout";

/** Una opción del menú contextual propio (el del webview traía «Recargar», que mata todas las terminales). */
export type MenuItem =
  | {
      label: string;
      icon?: LucideIcon;
      /** Atajo o dato a la derecha. */
      hint?: string;
      onSelect: () => void;
      disabled?: boolean;
    }
  | "separator";

export interface ContextMenuRequest {
  /** Coordenadas del clic (CSS, relativas a la ventana). */
  x: number;
  y: number;
  /** Para lectores de pantalla: de qué es el menú. */
  label: string;
  items: MenuItem[];
}

/** Qué busca el buscador: nombres de archivo o texto dentro de ellos. */
export type FinderMode = "files" | "text";

export interface FinderRequest {
  mode: FinderMode;
  /** Carpeta a la que se limita (relativa a la raíz del proyecto); `undefined` = la que tenga elegida. */
  dir?: string;
  /** Texto con el que empieza (p. ej. lo seleccionado en la terminal). */
  query?: string;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Se llama si se cancela (Esc, botón o clic fuera). */
  onCancel?: () => void;
  /** Decisiones de confianza: el foco empieza en Cancelar (un Enter de más no aprueba nada). */
  safeDefault?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

interface UiState {
  isPaletteOpen: boolean;
  isSettingsOpen: boolean;
  isOverviewOpen: boolean;
  isMissionOpen: boolean;
  /** El buscador (⌘P archivos, ⌘⇧F texto) abierto y con qué. */
  finder: FinderRequest | null;
  contextMenu: ContextMenuRequest | null;
  /** Detalle del sistema (CPU, GPU, memoria, procesos) sobre la barra de estado. */
  isSystemOpen: boolean;
  /** Diálogo de servidor SSH: nuevo o editar uno guardado. */
  sshDialog: { id?: string } | null;
  /** ⌘ mantenido: se muestran los atajos sobre la interfaz. */
  showHints: boolean;
  confirm: ConfirmRequest | null;
  toast: Toast | null;
  /** Panel con la barra de búsqueda abierta. */
  findPaneId: string | null;
  /** Panel bajo el cursor mientras se arrastran archivos. */
  dropPaneId: string | null;
  /** Un panel que se arrastra por su barra: sobre qué panel y en qué zona caería (null = en ninguno). */
  paneDrag: PaneDrag | null;

  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setOverviewOpen: (open: boolean) => void;
  setMissionOpen: (open: boolean) => void;
  openFinder: (request: FinderRequest) => void;
  closeFinder: () => void;
  openContextMenu: (request: ContextMenuRequest) => void;
  closeContextMenu: () => void;
  setSystemOpen: (open: boolean) => void;
  setSshDialog: (dialog: { id?: string } | null) => void;
  setShowHints: (show: boolean) => void;
  askConfirm: (request: ConfirmRequest) => void;
  resolveConfirm: (accepted: boolean) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;
  dismissToast: (id: number) => void;
  setFindPane: (paneId: string | null) => void;
  setDropPane: (paneId: string | null) => void;
  setPaneDrag: (drag: PaneDrag | null) => void;
}

export interface PaneDrag {
  sourceId: string;
  targetId: string | null;
  zone: DropZone | null;
}

let toastSeq = 0;
const TOAST_MS = 4500;

export const useUiStore = create<UiState>((set, get) => ({
  isPaletteOpen: false,
  isSettingsOpen: false,
  isOverviewOpen: false,
  isMissionOpen: false,
  finder: null,
  contextMenu: null,
  isSystemOpen: false,
  sshDialog: null,
  showHints: false,
  confirm: null,
  toast: null,
  findPaneId: null,
  dropPaneId: null,
  paneDrag: null,

  setPaletteOpen: (open) => set({ isPaletteOpen: open }),
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setOverviewOpen: (open) => set({ isOverviewOpen: open }),
  setMissionOpen: (open) => set({ isMissionOpen: open }),
  openFinder: (request) => set({ finder: request, contextMenu: null }),
  closeFinder: () => set({ finder: null }),
  openContextMenu: (request) => set({ contextMenu: request }),
  closeContextMenu: () => {
    if (get().contextMenu) set({ contextMenu: null });
  },
  setSystemOpen: (open) => set({ isSystemOpen: open }),
  setSshDialog: (dialog) => set({ sshDialog: dialog }),
  setShowHints: (show) => {
    if (get().showHints !== show) set({ showHints: show });
  },
  askConfirm: (request) => set({ confirm: request }),
  resolveConfirm: (accepted) => {
    const request = get().confirm;
    set({ confirm: null });
    if (accepted) request?.onConfirm();
    else request?.onCancel?.();
  },

  showToast: (text, tone = "info") => {
    const id = ++toastSeq;
    set({ toast: { id, text, tone } });
    setTimeout(() => get().dismissToast(id), TOAST_MS);
  },
  dismissToast: (id) => {
    if (get().toast?.id === id) set({ toast: null });
  },

  setFindPane: (paneId) => set({ findPaneId: paneId }),
  setDropPane: (paneId) => {
    if (get().dropPaneId !== paneId) set({ dropPaneId: paneId });
  },
  // Llega en cada movimiento del puntero: sin cambios no hay re-render.
  setPaneDrag: (drag) => {
    const current = get().paneDrag;
    if (current === drag) return;
    if (current && drag && current.sourceId === drag.sourceId && current.targetId === drag.targetId && current.zone === drag.zone) return;
    set({ paneDrag: drag });
  },
}));
