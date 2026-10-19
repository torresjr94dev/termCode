import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./ipc";

export type GitHost = "github" | "gitlab" | "bitbucket" | "azure" | "other";

export interface RepoMeta {
  root: string;
  name: string;
  remoteUrl: string | null;
  webUrl: string | null;
  host: GitHost;
  defaultBranch: string | null;
}

export interface GitChange {
  path: string;
  origPath: string | null;
  /** Letra de estado en el índice (`.` = sin cambios). */
  index: string;
  /** Letra de estado en el árbol de trabajo (`.` = sin cambios, `?` = sin seguimiento). */
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export interface DiffText {
  text: string;
  truncated: boolean;
}

export interface CommitInfo {
  sha: string;
  short: string;
  author: string;
  time: number;
  parents: string[];
  refs: string[];
  subject: string;
}

export interface CommitFile {
  status: string;
  path: string;
  origPath: string | null;
}

export interface CommitDetail {
  body: string;
  authorEmail: string;
  base: string;
  files: CommitFile[];
}

export interface PrInfo {
  number: number;
  url: string;
  state: string;
  title: string;
  isDraft: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ignored: boolean;
}

export interface FilePreview {
  text: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  absolute: string;
}

/** Errores de git/gh/claude llegan como texto legible: se propagan tal cual. */
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("Solo disponible en la app de escritorio.");
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : String(err), { cause: err });
  }
}

export const gitApi = {
  repo: (cwd: string) => call<RepoMeta | null>("git_repo", { cwd }),
  status: (root: string) => call<GitStatus>("git_status", { root }),
  diff: (root: string, path: string, origPath: string | null, mode: "staged" | "worktree" | "untracked") =>
    call<DiffText>("git_diff", { root, path, origPath, mode }),
  stage: (root: string, paths: string[]) => call<void>("git_stage", { root, paths }),
  unstage: (root: string, paths: string[]) => call<void>("git_unstage", { root, paths }),
  discard: (root: string, tracked: string[], untracked: string[]) => call<void>("git_discard", { root, tracked, untracked }),
  commit: (root: string, message: string, amend: boolean) =>
    call<{ sha: string; summary: string }>("git_commit", { root, message, amend }),
  push: (root: string) => call<string>("git_push", { root }),
  pull: (root: string) => call<string>("git_pull", { root }),
  log: (root: string, skip: number, limit: number) => call<CommitInfo[]>("git_log", { root, skip, limit }),
  commitDetail: (root: string, sha: string) => call<CommitDetail>("git_commit_detail", { root, sha }),
  commitDiff: (root: string, base: string, sha: string, path: string, origPath: string | null) =>
    call<DiffText>("git_commit_diff", { root, base, sha, path, origPath }),
  prStatus: (root: string) => call<PrInfo | null>("pr_status", { root }),
  prCreate: (root: string, title: string, body: string, base: string, draft: boolean) =>
    call<{ url: string; created: boolean }>("pr_create", { root, title, body, base, draft }),
  aiCommitMessage: (root: string) => call<string>("ai_commit_message", { root }),
  aiPrDescription: (root: string, base: string) => call<{ title: string; body: string }>("ai_pr_description", { root, base }),
  list: (root: string, path: string) => call<FsEntry[]>("fs_list", { root, path }),
  read: (root: string, path: string) => call<FilePreview>("fs_read", { root, path }),
};

/** Cambio preparado (en el índice). */
export const isStaged = (c: GitChange) => !c.untracked && !c.conflicted && c.index !== ".";
/** Cambio sin preparar (árbol de trabajo o archivo nuevo). */
export const isUnstaged = (c: GitChange) => !c.conflicted && (c.untracked || c.worktree !== ".");

/** Letra que se muestra para un cambio desde un lado concreto. */
export function statusLetter(change: GitChange, side: "staged" | "unstaged"): string {
  if (change.conflicted) return "!";
  if (change.untracked) return "U";
  return side === "staged" ? change.index : change.worktree;
}
