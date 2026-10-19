import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./ipc";
import type { AgentBaseline, AgentWorktree } from "../types/layout";

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
  /** Operación a medias: merge · rebase · cherry-pick · revert. */
  operation: string | null;
}

export interface GitBranch {
  /** `feature/x`, o `origin/feature/x` si es remota. */
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Segundos Unix del último commit. */
  updatedAt: number;
  subject: string;
}

export interface StashEntry {
  index: number;
  message: string;
  createdAt: number;
}

export interface CiRun {
  name: string;
  status: string;
  conclusion: string;
  url: string;
}

export interface CiStatus {
  state: "pending" | "success" | "failure";
  sha: string;
  runs: CiRun[];
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

export interface LastCommit {
  sha: string;
  short: string;
  message: string;
  /** Ramas remotas que ya lo contienen: no vacío = publicado. */
  publishedIn: string[];
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
  /** UTF-8 válido: solo entonces se puede editar sin dañarlo. */
  utf8: boolean;
  /** Versión en disco al leerlo (para detectar cambios de otros). */
  version: string;
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
  lastCommit: (root: string) => call<LastCommit>("git_last_commit", { root }),
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
  applyPatch: (root: string, patch: string, reverse: boolean, cached: boolean) =>
    call<void>("git_apply_patch", { root, patch, reverse, cached }),
  reviewFiles: (root: string, base: string, baselineUntracked: string[]) =>
    call<CommitFile[]>("review_files", { root, base, baselineUntracked }),
  reviewDiff: (root: string, base: string, path: string, origPath: string | null, created: boolean) =>
    call<DiffText>("review_diff", { root, base, path, origPath, created }),
  agentBaseline: (paneId: string) => call<AgentBaseline | null>("agent_baseline", { paneId }),
  worktreeList: (root: string) => call<AgentWorktree[]>("git_worktree_list", { root }),
  worktreeCreateFor: (cwd: string, label: string) => call<string>("git_worktree_create", { cwd, label }),
  worktreeApply: (source: string, target: string) => call<number>("git_worktree_apply", { source, target }),
  worktreeRemove: (root: string, path: string) => call<void>("git_worktree_remove", { root, path }),
  branches: (root: string) => call<GitBranch[]>("git_branches", { root }),
  switchBranch: (root: string, name: string, create: boolean, remote: boolean) =>
    call<void>("git_switch", { root, name, create, remote }),
  stashList: (root: string) => call<StashEntry[]>("git_stash_list", { root }),
  stashPush: (root: string, message: string, includeUntracked: boolean) =>
    call<void>("git_stash_push", { root, message, includeUntracked }),
  stashAction: (root: string, action: "apply" | "pop" | "drop", index: number) =>
    call<void>("git_stash_action", { root, action, index }),
  finishOperation: (root: string, abort: boolean) => call<void>("git_operation_finish", { root, abort }),
  resolveConflict: (root: string, path: string, content: string) => call<void>("git_resolve_conflict", { root, path, content }),
  ciStatus: (root: string) => call<CiStatus | null>("ci_status", { root }),
  files: (root: string) => call<string[]>("fs_files", { root }),
  list: (root: string, path: string) => call<FsEntry[]>("fs_list", { root, path }),
  read: (root: string, path: string) => call<FilePreview>("fs_read", { root, path }),
  readImage: (root: string, path: string) => call<ArrayBuffer>("fs_read_image", { root, path }),
  /** Devuelve la versión nueva. `expectedVersion` null = sobrescribir aunque haya cambiado. */
  writeFile: (root: string, path: string, content: string, expectedVersion: string | null) =>
    call<string>("fs_write", { root, path, content, expectedVersion }),
  fileVersion: (root: string, path: string) => call<string>("fs_version", { root, path }),
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
