import { openUrl } from "@tauri-apps/plugin-opener";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { useProjectStore, initialRepoState, sameSource, type DiffSource, type ProjectTab } from "../store/projectStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { gitApi, isStaged, isUnstaged, type GitChange } from "./git";
import { IS_TAURI, shellQuote } from "./ipc";

const project = () => useProjectStore.getState();
const toast = (text: string, tone: "info" | "error" = "info") => useUiStore.getState().showToast(text, tone);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const LOG_PAGE = 60;
const POLL_MS = 2500;

/** Raíz para el árbol de archivos: el repo si lo hay, si no la carpeta del panel. */
export function projectRoot(): string | null {
  const { repo, cwd } = project();
  return repo?.root ?? cwd;
}

function activePaneId(): string | undefined {
  const { tabs, activeTabId } = useTerminalStore.getState();
  return tabs.find((t) => t.id === activeTabId)?.activePaneId;
}

/* ------------------------------------------------------------------ */
/* Seguimiento: el panel siempre refleja dónde está parado el panel   */
/* activo de la terminal.                                              */
/* ------------------------------------------------------------------ */

let syncing = false;

async function syncContext() {
  if (syncing || !IS_TAURI) return;
  syncing = true;
  try {
    const paneId = activePaneId();
    const info = paneId ? await terminalManager.info(paneId) : null;
    const cwd = info?.cwd ?? null;
    if (cwd && cwd !== project().cwd) {
      const previousRoot = projectRoot();
      const repo = await gitApi.repo(cwd).catch(() => null);
      const sameRepo = repo?.root === project().repo?.root;
      project().set({ cwd, repo, ...(sameRepo ? {} : initialRepoState) });
      if (!sameRepo && repo) void refreshPr();
      // Otra raíz (otro repo, o sin repo y otra carpeta): el árbol empieza de cero.
      if (projectRoot() !== previousRoot) {
        project().set({ tree: {}, expanded: {} });
        const { isOpen, tab } = project();
        if (isOpen && tab === "files") void loadDir("");
        if (isOpen && tab === "history" && repo) void loadLog(true);
      }
    }
    await refreshStatus();
  } finally {
    syncing = false;
  }
}

export async function refreshStatus() {
  const root = project().repo?.root;
  if (!root) return;
  try {
    const status = await gitApi.status(root);
    const current = project().status;
    // Sin cambios no hay re-render: el panel se refresca cada pocos segundos.
    if (JSON.stringify(current) !== JSON.stringify(status)) project().set({ status });
  } catch (err) {
    // El repo pudo desaparecer (rama borrada, carpeta movida): se re-descubre.
    void logWarn(`[webview] git status falló: ${errorText(err)}`).catch(() => {});
    project().set({ cwd: null });
  }
}

async function refreshPr() {
  const root = project().repo?.root;
  if (!root || project().repo?.host !== "github") {
    project().set({ pr: null });
    return;
  }
  const pr = await gitApi.prStatus(root).catch(() => null);
  if (project().repo?.root === root) project().set({ pr });
}

export function startProjectTracking(): () => void {
  if (!IS_TAURI) return () => {};
  const sync = () => void syncContext();
  // Sondeo solo con la ventana visible (no hace falta que tenga el foco: puede
  // estar en otro monitor mientras trabajas en el editor).
  const interval = setInterval(() => {
    if (document.visibilityState === "visible") sync();
  }, POLL_MS);
  const unsubscribe = useTerminalStore.subscribe((s, prev) => {
    if (s.activeTabId !== prev.activeTabId || s.tabs !== prev.tabs) setTimeout(sync, 50);
  });
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", sync);
  // Al arrancar, el PTY tarda un momento en existir: reintentos cortos.
  const boot = [300, 1000, 2000].map((ms) => setTimeout(sync, ms));
  return () => {
    clearInterval(interval);
    boot.forEach(clearTimeout);
    unsubscribe();
    window.removeEventListener("focus", sync);
    document.removeEventListener("visibilitychange", sync);
  };
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function openProject(tab: ProjectTab) {
  const { isOpen, tab: current } = project();
  // Mismo atajo dos veces = cerrar.
  if (isOpen && current === tab) {
    project().set({ isOpen: false });
    return;
  }
  project().set({ isOpen: true, tab });
  if (tab === "history" && project().logHead !== (project().status?.head ?? null)) void loadLog(true);
  if (tab === "files") void loadDir("");
  void syncContext();
}

export function closeProject() {
  project().set({ isOpen: false });
}

/* ------------------------------------------------------------------ */
/* Archivos                                                            */
/* ------------------------------------------------------------------ */

export async function loadDir(path: string) {
  const root = projectRoot();
  if (!root) return;
  project().set({ tree: { ...project().tree, [path]: "loading" } });
  try {
    const entries = await gitApi.list(root, path);
    project().set({ tree: { ...project().tree, [path]: entries } });
  } catch (err) {
    project().set({ tree: { ...project().tree, [path]: { error: errorText(err) } } });
  }
}

export function toggleDir(path: string) {
  const expanded = { ...project().expanded };
  if (expanded[path]) {
    delete expanded[path];
  } else {
    expanded[path] = true;
    if (!Array.isArray(project().tree[path])) void loadDir(path);
  }
  project().set({ expanded });
}

export async function openFile(path: string) {
  const root = projectRoot();
  if (!root) return;
  project().set({ viewer: { kind: "file", path } });
  try {
    const preview = await gitApi.read(root, path);
    if (project().viewer?.kind === "file" && (project().viewer as { path: string }).path === path) {
      project().set({ viewer: { kind: "file", path, preview } });
    }
  } catch (err) {
    project().set({ viewer: { kind: "file", path, error: errorText(err) } });
  }
}

/** Pega la ruta (escapada) en el panel activo de la terminal. */
export function pastePath(absolute: string) {
  const paneId = activePaneId();
  if (!paneId) return;
  terminalManager.paste(paneId, `${shellQuote(absolute)} `);
  terminalManager.focus(paneId);
}

export function absolutePath(rel: string): string | null {
  const root = projectRoot();
  return root ? `${root.replace(/\/$/, "")}/${rel}` : null;
}

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

export function sourceForChange(change: GitChange, side: "staged" | "unstaged"): DiffSource {
  const kind = side === "staged" ? "staged" : change.untracked ? "untracked" : "worktree";
  return { kind, path: change.path, origPath: change.origPath };
}

export async function openDiff(source: DiffSource, siblings: DiffSource[] = [source]) {
  const root = project().repo?.root;
  if (!root) return;
  project().set({ viewer: { kind: "diff", source, siblings } });
  try {
    const result =
      source.kind === "commit"
        ? await gitApi.commitDiff(root, source.base, source.sha, source.path, source.origPath)
        : await gitApi.diff(root, source.path, source.origPath, source.kind);
    const viewer = project().viewer;
    if (viewer?.kind === "diff" && viewer.source === source) {
      project().set({ viewer: { ...viewer, text: result.text, truncated: result.truncated } });
    }
  } catch (err) {
    const viewer = project().viewer;
    if (viewer?.kind === "diff" && viewer.source === source) project().set({ viewer: { ...viewer, error: errorText(err) } });
  }
}

export function stepDiff(delta: number) {
  const viewer = project().viewer;
  if (viewer?.kind !== "diff") return;
  const index = viewer.siblings.findIndex((s) => sameSource(s, viewer.source));
  const next = viewer.siblings[index + delta];
  if (next) void openDiff(next, viewer.siblings);
}

export function closeViewer() {
  project().set({ viewer: null });
  const paneId = activePaneId();
  if (paneId) terminalManager.focus(paneId);
}

/* ------------------------------------------------------------------ */
/* Índice y commits                                                    */
/* ------------------------------------------------------------------ */

async function withBusy<T>(busy: NonNullable<ReturnType<typeof project>["busy"]>, task: () => Promise<T>): Promise<T | undefined> {
  if (project().busy) return undefined;
  project().set({ busy });
  try {
    return await task();
  } catch (err) {
    toast(errorText(err), "error");
    return undefined;
  } finally {
    project().set({ busy: null });
    void refreshStatus();
  }
}

export const stage = (paths: string[]) =>
  withBusy("stage", async () => {
    const root = project().repo?.root;
    if (root && paths.length) await gitApi.stage(root, paths);
  });

export const unstage = (paths: string[]) =>
  withBusy("stage", async () => {
    const root = project().repo?.root;
    if (root && paths.length) await gitApi.unstage(root, paths);
  });

export function stageAll() {
  return stage((project().status?.changes ?? []).filter(isUnstaged).map((c) => c.path));
}

export function unstageAll() {
  return unstage((project().status?.changes ?? []).filter(isStaged).map((c) => c.path));
}

/** Descartar es irreversible: siempre con confirmación. */
export function discard(changes: GitChange[]) {
  const root = project().repo?.root;
  if (!root || !changes.length) return;
  const tracked = changes.filter((c) => !c.untracked).map((c) => c.path);
  const untracked = changes.filter((c) => c.untracked).map((c) => c.path);
  const what = changes.length === 1 ? `«${changes[0].path}»` : `${changes.length} archivos`;
  useUiStore.getState().askConfirm({
    title: `¿Descartar los cambios de ${what}?`,
    body: untracked.length
      ? "Los cambios sin preparar se pierden y los archivos nuevos se borran. No se puede deshacer."
      : "Los cambios sin preparar se pierden. No se puede deshacer.",
    confirmLabel: "Descartar",
    onConfirm: () => void withBusy("stage", () => gitApi.discard(root, tracked, untracked)),
  });
}

export async function generateCommitMessage() {
  const root = project().repo?.root;
  if (!root) return;
  const message = await withBusy("ai", () => gitApi.aiCommitMessage(root));
  if (message) project().set({ draft: message });
}

export async function commit() {
  const { repo, draft, amend, status } = project();
  if (!repo) return;
  if (!amend && !status?.changes.some(isStaged)) {
    toast("No hay cambios preparados: prepara archivos antes de hacer commit.", "error");
    return;
  }
  const result = await withBusy("commit", () => gitApi.commit(repo.root, draft, amend));
  if (result) {
    project().set({ draft: "", amend: false, logHead: null });
    toast(`Commit ${result.sha}: ${result.summary}`);
    if (project().tab === "history") void loadLog(true);
  }
}

export async function push() {
  const root = project().repo?.root;
  if (!root) return;
  const ok = await withBusy("push", () => gitApi.push(root));
  if (ok !== undefined) {
    toast("Rama publicada.");
    void refreshPr();
  }
}

export async function pull() {
  const root = project().repo?.root;
  if (!root) return;
  const out = await withBusy("pull", () => gitApi.pull(root));
  if (out !== undefined) toast(out.split("\n").pop() || "Actualizado.");
}

/* ------------------------------------------------------------------ */
/* Historial                                                           */
/* ------------------------------------------------------------------ */

export async function loadLog(reset = false) {
  const root = project().repo?.root;
  if (!root || project().logLoading) return;
  const skip = reset ? 0 : project().log.length;
  const head = project().status?.head ?? null;
  project().set({ logLoading: true, ...(reset ? { logDone: false } : {}) });
  try {
    const page = await gitApi.log(root, skip, LOG_PAGE);
    // Al recargar se reemplaza de golpe (sin vaciar antes): no parpadea.
    project().set({ log: [...(reset ? [] : project().log), ...page], logHead: head, logDone: page.length < LOG_PAGE });
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    project().set({ logLoading: false });
  }
}

export async function toggleCommit(sha: string) {
  const root = project().repo?.root;
  if (!root) return;
  if (project().openCommit?.sha === sha) {
    project().set({ openCommit: null });
    return;
  }
  project().set({ openCommit: { sha } });
  try {
    const detail = await gitApi.commitDetail(root, sha);
    if (project().openCommit?.sha === sha) project().set({ openCommit: { sha, detail } });
  } catch (err) {
    if (project().openCommit?.sha === sha) project().set({ openCommit: { sha, error: errorText(err) } });
  }
}

/* ------------------------------------------------------------------ */
/* Pull requests                                                       */
/* ------------------------------------------------------------------ */

export function defaultBase(): string {
  return project().repo?.defaultBranch ?? "main";
}

export async function generatePrDraft(base: string): Promise<{ title: string; body: string } | undefined> {
  const root = project().repo?.root;
  if (!root) return undefined;
  return withBusy("pr-ai", () => gitApi.aiPrDescription(root, base));
}

export async function createPr(title: string, body: string, base: string, draft: boolean): Promise<boolean> {
  const root = project().repo?.root;
  if (!root) return false;
  const result = await withBusy("pr", () => gitApi.prCreate(root, title, body, base, draft));
  if (!result) return false;
  if (result.created) {
    toast(`PR creado: ${result.url}`);
    void refreshPr();
  } else {
    toast("Rama publicada: termina el PR en el navegador.");
  }
  openExternal(result.url);
  return true;
}

export function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (IS_TAURI) openUrl(url).catch((err) => toast(errorText(err), "error"));
  else window.open(url, "_blank", "noopener,noreferrer");
}
