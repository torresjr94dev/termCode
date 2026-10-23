import { create } from "zustand";
import type {
  CiStatus,
  CommitDetail,
  CommitInfo,
  FilePreview,
  FsEntry,
  GitStatus,
  LastCommit,
  PrInfo,
  RepoMeta,
  StashEntry,
} from "../lib/git";
import type { ReviewNote } from "../lib/reviewNotes";

export type ProjectTab = "files" | "changes" | "history";

/** Qué diff mostrar. `root` permite ver diffs de otro árbol (p. ej. el worktree de un agente). */
export type DiffSource =
  | { kind: "staged" | "worktree" | "untracked"; path: string; origPath: string | null; root?: string }
  | { kind: "commit"; sha: string; short: string; base: string; path: string; origPath: string | null; root?: string }
  | {
      kind: "review";
      /** Foto del repo antes del agente. */
      base: string;
      path: string;
      origPath: string | null;
      /** El archivo no existía en la foto. */
      created: boolean;
      root: string;
      label: string;
      /** Panel del agente que hizo los cambios: ahí va la revisión. */
      paneId?: string;
    };

export type Viewer =
  | {
      kind: "diff";
      source: DiffSource;
      /** Lista de la que se abrió (para ir al anterior / siguiente). */
      siblings: DiffSource[];
      text?: string;
      truncated?: boolean;
      error?: string;
    }
  | {
      kind: "file";
      path: string;
      line?: number;
      preview?: FilePreview;
      /** Imágenes: blob URL con los bytes (se libera al cerrar o cambiar de archivo). */
      image?: { url: string; bytes: number };
      error?: string;
    }
  /** Archivo con marcas de conflicto, resuelto bloque a bloque. */
  | { kind: "conflict"; path: string; text?: string; error?: string }
  /** La salida completa de un comando de la terminal (se lee entera y se busca con ⌘F). */
  | {
      kind: "output";
      id: number;
      paneId: string;
      command: string;
      cwd: string | null;
      exitCode: number | null;
      running: boolean;
      durationMs: number;
      text: string;
      truncated: boolean;
    };

export type TreeNode = FsEntry[] | "loading" | { error: string };

export type Busy = "commit" | "ai" | "push" | "pull" | "stage" | "pr" | "pr-ai" | "branch" | "stash" | "resolve" | null;

interface ProjectState {
  isOpen: boolean;
  tab: ProjectTab;
  /** Carpeta del panel activo (o null si aún no se sabe). */
  cwd: string | null;
  /** Repo que contiene `cwd`; null si no es un repo git. */
  repo: RepoMeta | null;
  status: GitStatus | null;
  pr: PrInfo | null;
  /** Workflows del commit actual (GitHub + gh). */
  ci: CiStatus | null;
  stashes: StashEntry[];

  log: CommitInfo[];
  /** HEAD con el que se cargó `log` (si cambia, el historial está viejo). */
  logHead: string | null;
  logDone: boolean;
  logLoading: boolean;
  openCommit: { sha: string; detail?: CommitDetail; error?: string } | null;

  tree: Record<string, TreeNode>;
  expanded: Record<string, true>;

  draft: string;
  amend: boolean;
  /** Commit que reemplazaría el amend (cargado al activarlo). */
  amendBase: LastCommit | null;
  /** Lo que había escrito antes de activar amend: vuelve al desactivarlo. */
  draftBeforeAmend: string;
  busy: Busy;
  viewer: Viewer | null;
  isPrDialogOpen: boolean;
  isBranchPickerOpen: boolean;
  /** Comentarios por línea aún sin mandar (sobreviven a cerrar el visor). */
  notes: ReviewNote[];
  /** `git status` no terminó en este repo (se reintenta con espera creciente). */
  statusTrouble: { root: string; at: number } | null;
  /** El repo vive en una nube con File Provider (iCloud Drive, Dropbox…): por qué git puede colgarse. */
  cloudProvider: string | null;

  set: (patch: Partial<ProjectState>) => void;
}

export const initialRepoState = {
  status: null,
  pr: null,
  ci: null,
  stashes: [],
  log: [],
  logHead: null,
  logDone: false,
  logLoading: false,
  openCommit: null,
  tree: {},
  expanded: {},
  viewer: null,
  cloudProvider: null,
} satisfies Partial<ProjectState>;

export const useProjectStore = create<ProjectState>((set) => ({
  // Abierto en Archivos: al plegarlo queda un riel a la derecha (ver ProjectPanel).
  isOpen: true,
  tab: "files",
  cwd: null,
  repo: null,
  ...initialRepoState,
  draft: "",
  amend: false,
  amendBase: null,
  draftBeforeAmend: "",
  busy: null,
  isPrDialogOpen: false,
  isBranchPickerOpen: false,
  notes: [],
  statusTrouble: null,
  set: (patch) => set(patch),
}));

/** Dos orígenes de diff apuntan al mismo archivo/versión. */
export function sameSource(a: DiffSource, b: DiffSource): boolean {
  if (a.kind !== b.kind || a.path !== b.path || a.root !== b.root) return false;
  if (a.kind === "commit") return b.kind === "commit" && a.sha === b.sha;
  if (a.kind === "review") return b.kind === "review" && a.base === b.base;
  return true;
}
