import { create } from "zustand";
import { validateServer, type SavedServer, type ServerFields, type SshHost } from "../lib/ssh";

/** Carpetas recientes que se recuerdan (las fijadas no cuentan para el tope). */
export const MAX_RECENT = 8;

export type SidebarSection = "places" | "servers" | "system";

export interface Place {
  path: string;
  /** Última vez que una shell estuvo ahí (ms). */
  at: number;
}

export interface SidebarData {
  recent: Place[];
  pinned: string[];
  collapsed: Partial<Record<SidebarSection, boolean>>;
  /** Servidores SSH que agregaste en termCode (los de ~/.ssh/config no se guardan aquí). */
  servers: SavedServer[];
  /** Workspaces aprobados: `raíz#sha256` del contenido (si cambia, se vuelve a preguntar). */
  trustedWorkspaces: string[];
}

interface SidebarState extends SidebarData {
  /** Una shell llegó a `path` (OSC 7). `home`: tu carpeta de inicio, que no se lista (siempre está a un `cd`). */
  visit: (path: string, home: string | null, at?: number) => void;
  togglePin: (path: string) => void;
  forget: (path: string) => void;
  toggleSection: (section: SidebarSection) => void;
  hydrate: (data: unknown) => void;
  /** Los `Host` de ~/.ssh/config (se leen al abrir; no se guardan). */
  sshHosts: SshHost[];
  setSshHosts: (hosts: SshHost[]) => void;
  /** Guarda (o reemplaza, con `id`) un servidor ya validado. Devuelve su id. */
  saveServer: (fields: ServerFields, id?: string) => string | null;
  removeServer: (id: string) => void;
  trustWorkspace: (key: string) => void;
}

const sameDir = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

/** Raíz del disco: no es un lugar al que se vuelva. */
const isRoot = (path: string) => /^(\/|[A-Za-z]:[\\/]?)$/.test(path);

/** Lo que llega del disco puede venir editado a mano o de otra versión: solo pasa lo válido. */
export function sanitizeSidebar(input: unknown): SidebarData {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof SidebarData, unknown>>;
  const isPath = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 4096;
  const recent = (Array.isArray(raw.recent) ? raw.recent : [])
    .filter((p): p is Place => isPath((p as Place)?.path) && typeof (p as Place).at === "number" && Number.isFinite((p as Place).at))
    .map(({ path, at }) => ({ path, at }))
    .slice(0, MAX_RECENT);
  const pinned = [...new Set((Array.isArray(raw.pinned) ? raw.pinned : []).filter(isPath))].slice(0, 50);
  const collapsedRaw = (raw.collapsed && typeof raw.collapsed === "object" ? raw.collapsed : {}) as Record<string, unknown>;
  const collapsed: SidebarData["collapsed"] = {};
  for (const key of ["places", "servers", "system"] as const) {
    if (typeof collapsedRaw[key] === "boolean") collapsed[key] = collapsedRaw[key] as boolean;
  }
  const servers = (Array.isArray(raw.servers) ? raw.servers : [])
    .filter((s): s is SavedServer => {
      const server = s as SavedServer;
      if (typeof server?.id !== "string" || typeof server.name !== "string" || typeof server.host !== "string") return false;
      if (typeof server.user !== "string" || typeof server.port !== "number" || typeof server.identityFile !== "string") return false;
      // Un servidor editado a mano que ya no es válido no llega a la línea de comandos.
      return Object.keys(validateServer(server)).length === 0;
    })
    .map(({ id, name, user, host, port, identityFile }) => ({ id, name, user, host, port, identityFile }))
    .slice(0, 100);
  const trustedWorkspaces = (Array.isArray(raw.trustedWorkspaces) ? raw.trustedWorkspaces : [])
    .filter((k): k is string => typeof k === "string" && /#[0-9a-f]{64}$/.test(k) && k.length < 4200)
    .slice(-50);
  return { recent, pinned, collapsed, servers, trustedWorkspaces };
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  recent: [],
  pinned: [],
  collapsed: {},
  servers: [],
  trustedWorkspaces: [],
  sshHosts: [],

  visit: (path, home, at = Date.now()) => {
    if (!path || isRoot(path) || (home && sameDir(path, home))) return;
    const { recent } = get();
    // Cada prompt repite la carpeta: si ya es la primera, no hay nada que cambiar (ni que guardar).
    if (recent[0] && sameDir(recent[0].path, path)) return;
    const rest = recent.filter((p) => !sameDir(p.path, path));
    set({ recent: [{ path, at }, ...rest].slice(0, MAX_RECENT) });
  },

  togglePin: (path) => {
    const { pinned } = get();
    set({ pinned: pinned.some((p) => sameDir(p, path)) ? pinned.filter((p) => !sameDir(p, path)) : [...pinned, path] });
  },

  forget: (path) => {
    const { recent, pinned } = get();
    set({ recent: recent.filter((p) => !sameDir(p.path, path)), pinned: pinned.filter((p) => !sameDir(p, path)) });
  },

  toggleSection: (section) => set((s) => ({ collapsed: { ...s.collapsed, [section]: !s.collapsed[section] } })),

  hydrate: (data) => set(sanitizeSidebar(data)),

  setSshHosts: (hosts) => set({ sshHosts: hosts }),

  saveServer: (fields, id) => {
    if (Object.keys(validateServer(fields)).length) return null;
    const clean: ServerFields = {
      name: fields.name.trim(),
      user: fields.user.trim(),
      host: fields.host.trim(),
      port: fields.port,
      identityFile: fields.identityFile.trim(),
    };
    const { servers } = get();
    if (id && servers.some((s) => s.id === id)) {
      set({ servers: servers.map((s) => (s.id === id ? { id, ...clean } : s)) });
      return id;
    }
    const fresh = `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set({ servers: [...servers, { id: fresh, ...clean }] });
    return fresh;
  },

  removeServer: (id) => set({ servers: get().servers.filter((s) => s.id !== id) }),

  trustWorkspace: (key) => {
    const { trustedWorkspaces } = get();
    // La misma raíz con otro contenido: la aprobación anterior ya no vale.
    const root = key.slice(0, key.lastIndexOf("#"));
    const kept = trustedWorkspaces.filter((k) => k.slice(0, k.lastIndexOf("#")) !== root);
    set({ trustedWorkspaces: [...kept, key].slice(-50) });
  },
}));

/** Fijadas primero (en el orden en que las fijaste) y luego las recientes que no lo están. */
export function placesToShow(data: Pick<SidebarData, "recent" | "pinned">, limit: number): Array<{ path: string; pinned: boolean; at?: number }> {
  const pinned = data.pinned.map((path) => ({ path, pinned: true, at: data.recent.find((p) => sameDir(p.path, path))?.at }));
  const recent = data.recent.filter((p) => !data.pinned.some((q) => sameDir(q, p.path))).map((p) => ({ path: p.path, pinned: false, at: p.at }));
  return [...pinned, ...recent].slice(0, Math.max(limit, pinned.length));
}
