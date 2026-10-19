import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Se llama si se cancela (Esc, botón o clic fuera). */
  onCancel?: () => void;
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
  isFinderOpen: boolean;
  /** ⌘ mantenido: se muestran los atajos sobre la interfaz. */
  showHints: boolean;
  confirm: ConfirmRequest | null;
  toast: Toast | null;
  /** Panel con la barra de búsqueda abierta. */
  findPaneId: string | null;
  /** Panel bajo el cursor mientras se arrastran archivos. */
  dropPaneId: string | null;

  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setOverviewOpen: (open: boolean) => void;
  setMissionOpen: (open: boolean) => void;
  setFinderOpen: (open: boolean) => void;
  setShowHints: (show: boolean) => void;
  askConfirm: (request: ConfirmRequest) => void;
  resolveConfirm: (accepted: boolean) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;
  dismissToast: (id: number) => void;
  setFindPane: (paneId: string | null) => void;
  setDropPane: (paneId: string | null) => void;
}

let toastSeq = 0;
const TOAST_MS = 4500;

export const useUiStore = create<UiState>((set, get) => ({
  isPaletteOpen: false,
  isSettingsOpen: false,
  isOverviewOpen: false,
  isMissionOpen: false,
  isFinderOpen: false,
  showHints: false,
  confirm: null,
  toast: null,
  findPaneId: null,
  dropPaneId: null,

  setPaletteOpen: (open) => set({ isPaletteOpen: open }),
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setOverviewOpen: (open) => set({ isOverviewOpen: open }),
  setMissionOpen: (open) => set({ isMissionOpen: open }),
  setFinderOpen: (open) => set({ isFinderOpen: open }),
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
}));
