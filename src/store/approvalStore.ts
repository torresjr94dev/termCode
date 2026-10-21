import { create } from "zustand";

/** Un agente pide permiso para usar una herramienta (hook `PermissionRequest` de Claude Code). */
export interface ApprovalRequest {
  id: string;
  paneId: string;
  /** `Bash`, `Edit`, `Write`, `mcp__servidor__herramienta`… */
  tool: string;
  /** Lo que el agente quiere hacer, completo (nunca recortado). */
  input: unknown;
  cwd: string | null;
  /** Llegada (ms). */
  at: number;
  /** Después de esto el backend suelta la espera y Claude pregunta en su panel. */
  expiresAt: number;
}

export type ApprovalDecision = "allow" | "deny" | "ask";

interface ApprovalState {
  requests: ApprovalRequest[];
  add: (request: ApprovalRequest) => void;
  remove: (id: string) => void;
  /** Al recargar el webview: lo que el backend sigue esperando. */
  replaceAll: (requests: ApprovalRequest[]) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  requests: [],
  add: (request) =>
    set((state) =>
      state.requests.some((r) => r.id === request.id) ? state : { requests: [...state.requests, request].sort((a, b) => a.at - b.at) },
    ),
  remove: (id) =>
    set((state) => (state.requests.some((r) => r.id === id) ? { requests: state.requests.filter((r) => r.id !== id) } : state)),
  replaceAll: (requests) => set({ requests: [...requests].sort((a, b) => a.at - b.at) }),
}));
