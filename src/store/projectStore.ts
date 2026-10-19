import { create } from "zustand";
import type { CommitDetail, CommitInfo, FilePreview, FsEntry, GitStatus, LastCommit, PrInfo, RepoMeta } from "../lib/git";

export type ProjectTab = "files" | "changes" | "history";

/** Qué diff mostrar. */
export type DiffSource =
  | { kind: "staged" | "worktree" | "untracked"; path: string; origPath: string | null }
  | { kind: "commit"; sha: string; short: string; base: string; path: string; origPath: string | null };

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
  | { kind: "file"; path: string; preview?: FilePreview; error?: string };

export type TreeNode = FsEntry[] | "loading" | { error: string };

export type Busy = "commit" | "ai" | "push" | "pull" | "stage" | "pr" | "pr-ai" | null;

interface ProjectState {
  isOpen: boolean;
  tab: ProjectTab;
  /** Carpeta del panel activo (o null si aún no se sabe). */
  cwd: string | null;
  /** Repo que contiene `cwd`; null si no es un repo git. */
  repo: RepoMeta | null;
  status: GitStatus | null;
  pr: PrInfo | null;

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

  set: (patch: Partial<ProjectState>) => void;
}

export const initialRepoState = {
  status: null,
  pr: null,
  log: [],
  logHead: null,
  logDone: false,
  logLoading: false,
  openCommit: null,
  tree: {},
  expanded: {},
  viewer: null,
} satisfies Partial<ProjectState>;

export const useProjectStore = create<ProjectState>((set) => ({
  isOpen: false,
  tab: "changes",
  cwd: null,
  repo: null,
  ...initialRepoState,
  draft: "",
  amend: false,
  amendBase: null,
  draftBeforeAmend: "",
  busy: null,
  isPrDialogOpen: false,
  set: (patch) => set(patch),
}));

/** Dos orígenes de diff apuntan al mismo archivo/versión. */
export function sameSource(a: DiffSource, b: DiffSource): boolean {
  if (a.kind !== b.kind || a.path !== b.path) return false;
  return a.kind !== "commit" || (b.kind === "commit" && a.sha === b.sha);
}
