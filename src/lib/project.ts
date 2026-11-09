import { openUrl } from "@tauri-apps/plugin-opener";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { clampDock, useProjectStore, initialRepoState, sameSource, type DiffSource, type FileTab, type ProjectTab } from "../store/projectStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { gitApi, isStaged, isUnstaged, type FilePreview, type GitChange, type StashEntry } from "./git";
import { IS_TAURI, ipc, quotePath } from "./ipc";
import { settingsNow } from "../store/settingsStore";
import { collectPanes, findOwnerTab, findPane } from "./layout";
import { joinPath, relativeInside } from "./paths";
import { formatReview, type ReviewNote } from "./reviewNotes";
import { sysLabel } from "./shortcuts";

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
/** Alguien pidió sincronizar mientras otra sincronización corría: se repite al terminar con el panel de ahora. */
let syncAgain = false;
/** Si git no contesta la raíz del repo en este tiempo, el panel sigue sin él (se reintenta en el siguiente sondeo). */
const REPO_LOOKUP_MS = 4000;

/**
 * El panel sigue al panel activo de la terminal. Cambiar de carpeta nunca
 * espera a `git status`: en un repo lento (p. ej. en iCloud) eso tardaba
 * hasta 20 s y, mientras, los clics en otros paneles no cambiaban nada.
 */
async function syncContext() {
  if (!IS_TAURI) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    const paneId = activePaneId();
    // OSC 7 (integración con la shell) es instantáneo; si no hay (agentes), se pregunta al proceso.
    const known = paneId ? terminalManager.knownCwd(paneId) : null;
    const cwd = known ?? (paneId ? (await terminalManager.info(paneId))?.cwd : null) ?? null;
    if (cwd && cwd !== project().cwd) {
      const previousRoot = projectRoot();
      const repo = await Promise.race([
        gitApi.repo(cwd).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), REPO_LOOKUP_MS)),
      ]);
      // Mientras git contestaba, pudiste ir a otro panel: lo de esta carpeta ya no vale.
      if (activePaneId() !== paneId) {
        syncAgain = true;
        return;
      }
      const sameRepo = repo?.root === project().repo?.root;
      if (!sameRepo) exitAmend();
      project().set({ cwd, repo, ...(sameRepo ? {} : { ...initialRepoState, statusTrouble: null }) });
      if (!sameRepo && repo) {
        void refreshPr();
        void refreshCi(true);
        void refreshStashes();
        void detectCloud(repo.root);
      }
      // Otra raíz (otro repo, o sin repo y otra carpeta): el árbol empieza de cero
      // y el visor se cierra (lo editado espera en su pestaña, que es de la raíz vieja).
      if (projectRoot() !== previousRoot) {
        project().set({ tree: {}, expanded: {}, viewer: null });
        const { isOpen, tab } = project();
        if (isOpen && tab === "files") void loadDir("");
        if (isOpen && tab === "history" && repo) void loadLog(true);
      }
    }
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      void syncContext();
    }
  }
  void refreshStatus();
  void refreshCi();
}

/** Re-sincroniza ahora (p. ej. tras un `cd` que avisó la shell). */
export function syncNow() {
  void syncContext();
}

/** Repos donde `git status` no terminó: no se le vuelve a preguntar hasta `until`. */
const stalled = new Map<string, { failures: number; until: number }>();
/** Una consulta de estado a la vez por repo (git ya tarda; apilarlas solo lo empeora). */
let statusInFlight: string | null = null;
const STALL_BASE_MS = 30_000;
const STALL_MAX_MS = 10 * 60_000;

const isTimeout = (err: unknown) => /tardó demasiado/.test(errorText(err));

/** ¿El repo vive en iCloud Drive (u otra nube)? Explica por qué git puede no contestar. */
async function detectCloud(root: string) {
  const provider = await ipc.cloudProvider(root);
  if (project().repo?.root === root) project().set({ cloudProvider: provider });
}

export async function refreshStatus({ force = false } = {}) {
  const root = project().repo?.root;
  if (!root || statusInFlight === root) return;
  const stall = stalled.get(root);
  if (stall && !force && Date.now() < stall.until) return;
  statusInFlight = root;
  try {
    const status = await gitApi.status(root);
    stalled.delete(root);
    if (project().repo?.root !== root) return;
    if (project().statusTrouble) project().set({ statusTrouble: null });
    const { amend, amendBase } = project();
    if (amend && amendBase && status.head && !amendBase.sha.startsWith(status.head)) {
      exitAmend();
      toast("El último commit cambió (¿commit o checkout en la terminal?): amend desactivado.");
    }
    const current = project().status;
    // Sin cambios no hay re-render: el panel se refresca cada pocos segundos.
    if (JSON.stringify(current) !== JSON.stringify(status)) {
      project().set({ status });
      // Commit, checkout o stash desde la terminal: lo que depende de HEAD se pone al día.
      if (current && current.head !== status.head) void refreshCi(true);
      if (current) void refreshStashes();
    }
  } catch (err) {
    if (isTimeout(err)) {
      // git se quedó esperando (p. ej. a que iCloud baje un archivo): se espera cada vez
      // más antes de reintentar, y el aviso va en el panel, no en el log cada 20 s.
      const failures = (stall?.failures ?? 0) + 1;
      stalled.set(root, { failures, until: Date.now() + Math.min(STALL_BASE_MS * 2 ** (failures - 1), STALL_MAX_MS) });
      if (failures === 1) void logWarn(`[webview] git status no terminó en ${root}; se reintenta con espera creciente`).catch(() => {});
      if (project().repo?.root === root) project().set({ statusTrouble: { root, at: Date.now() } });
      return;
    }
    // El repo pudo desaparecer (rama borrada, carpeta movida): se re-descubre.
    void logWarn(`[webview] git status falló: ${errorText(err)}`).catch(() => {});
    project().set({ cwd: null });
  } finally {
    if (statusInFlight === root) statusInFlight = null;
  }
}

/** «Reintentar» del aviso: sin esperar al siguiente intento programado. */
export function retryStatus() {
  const root = project().repo?.root;
  if (root) stalled.delete(root);
  void refreshStatus({ force: true });
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
  if (tab === "changes") void refreshStashes();
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

/* ------------------------------------------------------------------ */
/* Pestañas del visor y cambios sin guardar                            */
/* ------------------------------------------------------------------ */

/** Pestañas por raíz como máximo: al abrir otra se cierra la más vieja que no tenga cambios. */
export const MAX_FILE_TABS = 12;

/**
 * Lo que el editor de una pestaña tenía al dejar de verse (otra pestaña, Esc,
 * otro repo): texto, cursor y deshacer. `version`: la de disco sobre la que
 * se hicieron esos cambios (la que se exige al guardar).
 */
export interface StoredEditor {
  session: unknown;
  version: string;
  dirty: boolean;
}

const sessions = new Map<string, StoredEditor>();
const tabKey = (root: string, path: string) => `${root}\u0000${path}`;

export function storeEditorSession(root: string, path: string, stored: StoredEditor) {
  sessions.set(tabKey(root, path), stored);
}

/** La sesión guardada de esa pestaña, sin tomarla. */
export function peekEditorSession(root: string, path: string): StoredEditor | undefined {
  return sessions.get(tabKey(root, path));
}

/** La sesión guardada de esa pestaña (y se olvida: ahora la tiene el editor). */
export function takeEditorSession(root: string, path: string): StoredEditor | undefined {
  const key = tabKey(root, path);
  const stored = sessions.get(key);
  sessions.delete(key);
  return stored;
}

export function findFileTab(root: string | null, path: string): FileTab | undefined {
  return root ? project().fileTabs.find((t) => t.root === root && t.path === path) : undefined;
}

export function tabsOfRoot(root: string | null): FileTab[] {
  return root ? project().fileTabs.filter((t) => t.root === root) : [];
}

function updateTab(root: string, path: string, patch: Partial<FileTab>) {
  const tabs = project().fileTabs;
  const index = tabs.findIndex((t) => t.root === root && t.path === path);
  if (index === -1) return;
  const tab = tabs[index];
  if ((Object.keys(patch) as Array<keyof FileTab>).every((k) => tab[k] === patch[k])) return;
  const next = [...tabs];
  next[index] = { ...tab, ...patch };
  project().set({ fileTabs: next });
}

let lastUnsaved = false;
/** El backend no cierra la ventana con trabajo sin guardar: se le avisa solo cuando cambia. */
function syncUnsavedFlag() {
  const now = hasUnsavedEdits();
  if (now === lastUnsaved) return;
  lastUnsaved = now;
  if (IS_TAURI) void ipc.setUnsaved(now);
}

export function setTabDirty(root: string, path: string, dirty: boolean) {
  updateTab(root, path, { dirty });
  syncUnsavedFlag();
}

export function setTabMarkdown(path: string, markdown: NonNullable<FileTab["markdown"]>) {
  const root = projectRoot();
  if (root) updateTab(root, path, { markdown });
}

/** Pestañas con cambios sin guardar, de cualquier repo. */
export const unsavedTabs = () => project().fileTabs.filter((t) => t.dirty);
export const hasUnsavedEdits = () => unsavedTabs().length > 0;

/** Abre (o reusa) la pestaña; si sobran, cierra la más vieja sin cambios que no sea esta. */
function addTab(root: string, path: string, markdown?: FileTab["markdown"]) {
  const tabs = project().fileTabs;
  if (tabs.some((t) => t.root === root && t.path === path)) {
    if (markdown) updateTab(root, path, { markdown });
    return;
  }
  let next = [...tabs, { root, path, dirty: false, markdown }];
  const mine = next.filter((t) => t.root === root);
  if (mine.length > MAX_FILE_TABS) {
    const victim = mine.find((t) => !t.dirty && t.path !== path);
    if (victim) {
      next = next.filter((t) => t !== victim);
      sessions.delete(tabKey(victim.root, victim.path));
    }
  }
  project().set({ fileTabs: next });
}

function askToCloseDirty(paths: string[]): Promise<boolean> {
  if (!paths.length) return Promise.resolve(true);
  return new Promise((resolve) =>
    useUiStore.getState().askConfirm({
      title: paths.length === 1 ? `¿Cerrar ${paths[0]} sin guardar?` : `¿Cerrar ${paths.length} archivos sin guardar?`,
      body: `${paths.join(", ")}: los cambios que no guardaste (${sysLabel("S")}) se pierden.`,
      confirmLabel: "Cerrar sin guardar",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  );
}

/**
 * Cierra pestañas de la raíz actual (con cambios, pregunta antes). Si se
 * cerró la que se ve, pasa a la vecina; sin ninguna, el visor se cierra.
 */
export async function closeFileTabs(paths: string[]) {
  const root = projectRoot();
  if (!root || !paths.length) return;
  const before = tabsOfRoot(root);
  const closing = before.filter((t) => paths.includes(t.path));
  if (!(await askToCloseDirty(closing.filter((t) => t.dirty).map((t) => t.path)))) return;
  for (const tab of closing) sessions.delete(tabKey(root, tab.path));
  project().set({ fileTabs: project().fileTabs.filter((t) => !(t.root === root && paths.includes(t.path))) });
  syncUnsavedFlag();

  const viewer = project().viewer;
  if (viewer?.kind !== "file" || !paths.includes(viewer.path)) return;
  const index = before.findIndex((t) => t.path === viewer.path);
  const remaining = before.filter((t) => !paths.includes(t.path));
  const neighbour = remaining[Math.min(index, remaining.length - 1)];
  if (neighbour) void openFile(neighbour.path);
  else closeViewer();
}

/** ⌘W en el visor: la pestaña que se ve. */
export function closeActiveFileTab() {
  const viewer = project().viewer;
  if (viewer?.kind === "file") void closeFileTabs([viewer.path]);
  else closeViewer();
}

/** ⌃Tab / ⌃⇧Tab: la pestaña siguiente o la anterior (en círculo). */
export function cycleFileTab(delta: 1 | -1) {
  const viewer = project().viewer;
  const tabs = tabsOfRoot(projectRoot());
  if (viewer?.kind !== "file" || tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.path === viewer.path);
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next) void openFile(next.path);
}

/* ------------------------------------------------------------------ */
/* Recientes (⌘P sin escribir nada)                                    */
/* ------------------------------------------------------------------ */

const MAX_RECENT = 30;
const recents = new Map<string, string[]>();

function rememberRecent(root: string, path: string) {
  const list = (recents.get(root) ?? []).filter((p) => p !== path);
  list.unshift(path);
  recents.set(root, list.slice(0, MAX_RECENT));
}

/** Los últimos archivos abiertos en el visor en este proyecto, el más reciente primero. */
export function recentFiles(): string[] {
  const root = projectRoot();
  return root ? (recents.get(root) ?? []) : [];
}

/* ------------------------------------------------------------------ */
/* Visor de archivos: texto (editable) e imágenes                      */
/* ------------------------------------------------------------------ */

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
};

export function imageMime(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? (IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null) : null;
}

export const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

// Las imágenes viven en blob URLs: se liberan en cuanto el visor deja de mostrarlas.
useProjectStore.subscribe((state, prev) => {
  const before = prev.viewer?.kind === "file" ? prev.viewer.image?.url : undefined;
  const now = state.viewer?.kind === "file" ? state.viewer.image?.url : undefined;
  if (before && before !== now) URL.revokeObjectURL(before);
});

/** A dónde saltar al abrir: una línea y, si viene de una búsqueda, la coincidencia a seleccionar. */
export interface FileTarget {
  line?: number;
  column?: number;
  length?: number;
  markdown?: FileTab["markdown"];
}

let jumpSeq = 0;

/**
 * Abre el archivo en su pestaña (la crea si no hay). Cambiar de pestaña no
 * pierde nada: el editor que deja de verse guarda texto, cursor y deshacer.
 */
export async function openFile(path: string, target?: number | FileTarget) {
  const root = projectRoot();
  if (!root) return;
  const { line, column, length, markdown } = typeof target === "number" ? { line: target } : (target ?? {});
  // Saltar a una línea es cosa del texto: un Markdown pasa a mostrarse como texto (o sigue en «Ambos»).
  const showsText = findFileTab(root, path)?.markdown === "split";
  addTab(root, path, markdown ?? (line && !showsText ? "source" : undefined));
  rememberRecent(root, path);
  const jump = line ? ++jumpSeq : undefined;
  const current = project().viewer;
  // Mismo archivo (p. ej. ⌘-clic en otra línea): solo se salta, sin releerlo.
  if (current?.kind === "file" && current.path === path && (current.preview || current.image)) {
    project().set({ viewer: { ...current, line, column, length, jump } });
    return;
  }
  const position = { line, column, length, jump };
  project().set({ viewer: { kind: "file", path, ...position } });
  const stillOpen = () => {
    const viewer = project().viewer;
    return viewer?.kind === "file" && viewer.path === path && projectRoot() === root;
  };
  try {
    const mime = imageMime(path);
    if (mime) {
      const bytes = await gitApi.readImage(root, path);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      if (stillOpen()) project().set({ viewer: { kind: "file", path, image: { url, bytes: bytes.byteLength } } });
      else URL.revokeObjectURL(url);
      return;
    }
    const preview = await gitApi.read(root, path);
    if (stillOpen()) project().set({ viewer: { kind: "file", path, ...position, preview } });
  } catch (err) {
    if (stillOpen()) project().set({ viewer: { kind: "file", path, ...position, error: errorText(err) } });
  }
}

export type SaveResult = { status: "saved"; version: string } | { status: "conflict" } | { status: "error" };

/**
 * Guarda lo editado. `expectedVersion`: la versión de disco sobre la que se
 * editó (si otro cambió el archivo después, no se pisa: «conflict»); null
 * sobrescribe a sabiendas.
 */
export async function saveFile(root: string, path: string, content: string, expectedVersion: string | null): Promise<SaveResult> {
  try {
    const version = await gitApi.writeFile(root, path, content, expectedVersion);
    const now = project().viewer;
    if (now?.kind === "file" && now.path === path && now.preview && projectRoot() === root) {
      project().set({ viewer: { ...now, preview: { ...now.preview, text: content, version } } });
    }
    void refreshStatus();
    return { status: "saved", version };
  } catch (err) {
    const text = errorText(err);
    if (text.includes("cambió en disco")) return { status: "conflict" };
    toast(text, "error");
    return { status: "error" };
  }
}

/** Relee el archivo del disco (otro lo cambió). `root`: la del editor, no la de ahora. */
export async function reloadFile(root: string, path: string): Promise<FilePreview | null> {
  try {
    const preview = await gitApi.read(root, path);
    const now = project().viewer;
    if (now?.kind === "file" && now.path === path && projectRoot() === root) project().set({ viewer: { ...now, preview } });
    return preview;
  } catch (err) {
    toast(errorText(err), "error");
    return null;
  }
}

/** ¿Cambió en disco desde `version`? (null si no se pudo saber). */
export async function fileChangedOnDisk(root: string, path: string, version: string): Promise<boolean | null> {
  try {
    return (await gitApi.fileVersion(root, path)) !== version;
  } catch {
    return null;
  }
}

/**
 * Abre en el visor si el archivo está dentro del proyecto actual. `false` si no.
 * Las rutas del proyecto son relativas y con `/` (como las da git), también en
 * Windows, donde la raíz y el enlace llegan como `C:\…`.
 */
export function openFileAbsolute(absolute: string, line?: number): boolean {
  const root = projectRoot();
  const rel = root ? relativeInside(absolute, root) : null;
  if (!rel) return false;
  void openFile(rel.replace(/\\/g, "/"), line);
  return true;
}

/** Pega la ruta (escapada) en el panel activo de la terminal. */
export function pastePath(absolute: string) {
  const paneId = activePaneId();
  if (!paneId) return;
  terminalManager.paste(paneId, `${quotePath(absolute)} `);
  terminalManager.focus(paneId);
}

/** Copia una ruta (o cualquier texto) y lo dice. */
export async function copyText(text: string, done = "Ruta copiada.") {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("No se pudo copiar al portapapeles.", "error");
  }
}

export function absolutePath(rel: string): string | null {
  const root = projectRoot();
  return root ? joinPath(root, rel) : null;
}

/** Abre un archivo del proyecto en el editor de los ajustes. */
export async function openInEditor(rel: string, line?: number) {
  const absolute = absolutePath(rel);
  if (!absolute) return;
  try {
    await ipc.openInEditor(absolute, line ?? null, settingsNow().editor);
  } catch (err) {
    toast(`No se pudo abrir el editor: ${errorText(err)}`, "error");
  }
}

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

export function sourceForChange(change: GitChange, side: "staged" | "unstaged"): DiffSource {
  const kind = side === "staged" ? "staged" : change.untracked ? "untracked" : "worktree";
  return { kind, path: change.path, origPath: change.origPath };
}

export async function openDiff(source: DiffSource, siblings: DiffSource[] = [source]) {
  const root = source.root ?? project().repo?.root;
  if (!root) return;
  // Lo que estuviera editándose sigue en su pestaña (con su deshacer).
  project().set({ viewer: { kind: "diff", source, siblings } });
  try {
    const result =
      source.kind === "commit"
        ? await gitApi.commitDiff(root, source.base, source.sha, source.path, source.origPath)
        : source.kind === "review"
          ? await gitApi.reviewDiff(root, source.base, source.path, source.origPath, source.created)
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

export type HunkAction = "stage" | "unstage" | "discard" | "revert";

/** Qué se puede hacer con un fragmento según de dónde viene el diff. */
export function hunkActions(source: DiffSource): HunkAction[] {
  switch (source.kind) {
    case "worktree":
      return ["stage", "discard"];
    case "staged":
      return ["unstage"];
    case "review":
      return source.created ? [] : ["revert"];
    default:
      return [];
  }
}

/** Aplica un fragmento (parche) y recarga el diff para no mostrar un estado viejo. */
export async function applyHunk(action: HunkAction, patch: string) {
  const viewer = project().viewer;
  if (viewer?.kind !== "diff") return;
  const root = viewer.source.root ?? project().repo?.root;
  if (!root) return;
  const [reverse, cached] = {
    stage: [false, true],
    unstage: [true, true],
    discard: [true, false],
    revert: [true, false],
  }[action];
  try {
    await gitApi.applyPatch(root, patch, reverse, cached);
    void refreshStatus();
    await openDiff(viewer.source, viewer.siblings);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** Descartar/revertir pierde trabajo: confirmación antes. */
export function confirmHunk(action: HunkAction, patch: string) {
  if (action === "stage" || action === "unstage") {
    void applyHunk(action, patch);
    return;
  }
  useUiStore.getState().askConfirm({
    title: action === "revert" ? "¿Revertir este cambio del agente?" : "¿Descartar este fragmento?",
    body: "El archivo vuelve a como estaba en ese tramo. No se puede deshacer.",
    confirmLabel: action === "revert" ? "Revertir" : "Descartar",
    onConfirm: () => void applyHunk(action, patch),
  });
}

/* ------------------------------------------------------------------ */
/* Revisión de lo que hizo un agente                                   */
/* ------------------------------------------------------------------ */

/**
 * Abre el diff de todo lo que cambió desde la foto que tomó el hook al
 * recibir el prompt (`turn`) o al empezar la sesión (`session`).
 */
export async function reviewAgent(paneId: string, scope: "turn" | "session" = "turn"): Promise<boolean> {
  const baseline = await gitApi.agentBaseline(paneId).catch(() => null);
  const snap = baseline?.[scope];
  if (!snap) {
    toast("Ese agente aún no tiene una foto del repo: aparece al enviarle el primer mensaje (solo sesiones lanzadas desde termCode).");
    return false;
  }
  try {
    const files = await gitApi.reviewFiles(snap.root, snap.sha, snap.untracked);
    if (!files.length) {
      toast(scope === "turn" ? "El agente no cambió nada desde tu último mensaje." : "El agente no cambió nada en esta sesión.");
      return false;
    }
    const label = scope === "turn" ? "desde tu último mensaje" : "en toda la sesión";
    const sources: DiffSource[] = files.map((f) => ({
      kind: "review",
      base: snap.sha,
      path: f.path,
      origPath: f.origPath,
      created: f.status === "A" && !f.origPath,
      root: snap.root,
      label,
      paneId,
    }));
    await openDiff(sources[0], sources);
    return true;
  } catch (err) {
    toast(errorText(err), "error");
    return false;
  }
}

export function stepDiff(delta: number) {
  const viewer = project().viewer;
  if (viewer?.kind !== "diff") return;
  const index = viewer.siblings.findIndex((s) => sameSource(s, viewer.source));
  const next = viewer.siblings[index + delta];
  if (next) void openDiff(next, viewer.siblings);
}

/* ------------------------------------------------------------------ */
/* Revisión por líneas → al agente                                     */
/* ------------------------------------------------------------------ */

let noteSeq = 0;

export function addNote(note: Omit<ReviewNote, "id">) {
  if (!note.text.trim()) return;
  project().set({ notes: [...project().notes, { ...note, id: `note-${Date.now()}-${++noteSeq}` }] });
}

export function removeNote(id: string) {
  project().set({ notes: project().notes.filter((n) => n.id !== id) });
}

/**
 * Quién recibe la revisión: el agente que hizo esos cambios (si el diff lo
 * sabe) o el que trabaja en ese árbol (repo o worktree).
 */
export function reviewTarget(source: DiffSource): string | null {
  const agents = useTerminalStore
    .getState()
    .tabs.flatMap((t) => collectPanes(t.root))
    .filter((p) => p.agentType);
  if (source.kind === "review" && source.paneId && agents.some((p) => p.id === source.paneId)) return source.paneId;
  const root = source.root ?? project().repo?.root;
  if (!root) return null;
  const inside = agents.find((p) => {
    const cwd = terminalManager.knownCwd(p.id) ?? p.cwd;
    return cwd != null && relativeInside(cwd, root) !== null;
  });
  return inside?.id ?? null;
}

/**
 * Pega todos los comentarios de este árbol en el agente como un solo mensaje,
 * sin Enter: lo lees y lo mandas tú. Sin agente, se copia al portapapeles.
 */
export async function sendReview() {
  const viewer = project().viewer;
  if (viewer?.kind !== "diff") return;
  const root = viewer.source.root ?? project().repo?.root;
  const notes = project().notes.filter((n) => n.root === root);
  if (!root || !notes.length) return;
  const text = formatReview(notes);
  const target = reviewTarget(viewer.source);
  if (!target) {
    try {
      await navigator.clipboard.writeText(text);
      toast("No hay un agente trabajando en esa carpeta: copié la revisión al portapapeles.");
    } catch {
      toast("No hay un agente en esa carpeta y no se pudo copiar la revisión.", "error");
    }
    return;
  }
  const terminals = useTerminalStore.getState();
  const owner = findOwnerTab(terminals.tabs, target);
  const pane = owner ? findPane(owner.root, target) : undefined;
  terminalManager.paste(target, text);
  project().set({ notes: project().notes.filter((n) => n.root !== root), viewer: null });
  if (owner) {
    terminals.setActiveTab(owner.id);
    terminals.setActivePane(target);
  }
  toast(`Revisión pegada en ${pane?.title ?? "el agente"}: léela y pulsa Enter para mandarla.`);
}

/** El visor junto a las terminales (lado a lado) o encima de ellas. */
export function toggleViewerDock() {
  const dock = project().viewerDock;
  project().set({ viewerDock: { ...dock, docked: !dock.docked } });
}

export function setViewerDockWidth(width: number) {
  const dock = project().viewerDock;
  const next = clampDock(width);
  if (next !== dock.width) project().set({ viewerDock: { ...dock, width: next } });
}

/** Vuelve a las terminales. Las pestañas quedan abiertas (con lo no guardado): se retoman desde Archivos o ⌘P. */
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

/** Sale de amend devolviendo el borrador que había antes. */
function exitAmend() {
  if (!project().amend) return;
  project().set({ amend: false, amendBase: null, draft: project().draftBeforeAmend, draftBeforeAmend: "" });
}

/**
 * Activar amend carga el mensaje del último commit para editarlo (lo que
 * hubiera escrito se guarda y vuelve al desactivarlo).
 */
export async function setAmend(on: boolean) {
  const { repo, amend } = project();
  if (!repo || on === amend) return;
  if (!on) {
    exitAmend();
    return;
  }
  try {
    const last = await gitApi.lastCommit(repo.root);
    project().set({ amend: true, amendBase: last, draftBeforeAmend: project().draft, draft: last.message });
  } catch (err) {
    toast(errorText(err), "error");
  }
}

export async function generateCommitMessage() {
  const root = project().repo?.root;
  if (!root) return;
  const message = await withBusy("ai", () => gitApi.aiCommitMessage(root));
  if (message) project().set({ draft: message });
}

async function runCommit(root: string, message: string, amend: boolean) {
  const result = await withBusy("commit", () => gitApi.commit(root, message, amend));
  if (result) {
    project().set({ draft: "", amend: false, amendBase: null, draftBeforeAmend: "", logHead: null });
    toast(`${amend ? "Commit enmendado" : "Commit"} ${result.sha}: ${result.summary}`);
    if (project().tab === "history") void loadLog(true);
  }
}

export async function commit() {
  const { repo, draft, amend, amendBase, status } = project();
  if (!repo) return;
  if (!amend && !status?.changes.some(isStaged)) {
    toast("No hay cambios preparados: prepara archivos antes de hacer commit.", "error");
    return;
  }
  const published = amend ? (amendBase?.publishedIn ?? []) : [];
  if (!published.length) {
    await runCommit(repo.root, draft, amend);
    return;
  }
  // Reescribir algo que otros pueden tener: solo con confirmación explícita.
  useUiStore.getState().askConfirm({
    title: `¿Enmendar un commit ya publicado?`,
    body:
      `${amendBase?.short} ya está en ${published.join(", ")}. Enmendarlo reescribe historial compartido: ` +
      "el push normal será rechazado y tendrás que forzarlo (git push --force-with-lease). " +
      "Si alguien ya trabajó sobre ese commit, le romperás la rama.",
    confirmLabel: "Enmendar igualmente",
    onConfirm: () => void runCommit(repo.root, draft, true),
  });
}

export async function push() {
  const root = project().repo?.root;
  if (!root) return;
  const ok = await withBusy("push", () => gitApi.push(root));
  if (ok !== undefined) {
    toast("Rama publicada.");
    void refreshPr();
    // Los workflows tardan unos segundos en registrarse tras el push.
    setTimeout(() => void refreshCi(true), 6000);
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

/* ------------------------------------------------------------------ */
/* CI del commit actual                                                */
/* ------------------------------------------------------------------ */

let ciCheckedAt = 0;
const CI_PENDING_MS = 20_000;
const CI_IDLE_MS = 120_000;

/** Consulta el CI de HEAD (limitado: cada 20 s si corre algo, cada 2 min si no). */
export async function refreshCi(force = false) {
  const repo = project().repo;
  if (!repo || repo.host !== "github") {
    if (project().ci) project().set({ ci: null });
    return;
  }
  const previous = project().ci;
  const now = Date.now();
  if (!force && now - ciCheckedAt < (previous?.state === "pending" ? CI_PENDING_MS : CI_IDLE_MS)) return;
  ciCheckedAt = now;
  let ci: Awaited<ReturnType<typeof gitApi.ciStatus>> = null;
  try {
    ci = await gitApi.ciStatus(repo.root);
  } catch {
    // Sin red o sin gh: el indicador simplemente no aparece.
  }
  if (project().repo?.root !== repo.root) return;
  if (JSON.stringify(ci) === JSON.stringify(previous)) return;
  project().set({ ci });
  // Terminó el CI del mismo commit: se avisa (la ventana puede estar detrás del editor).
  if (previous?.state === "pending" && ci && ci.sha === previous.sha && ci.state !== "pending") {
    const branch = project().status?.branch ?? "HEAD";
    const failed = ci.runs.filter((r) => r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion));
    const title = ci.state === "success" ? `CI en verde · ${branch}` : `CI falló · ${branch}`;
    const body = ci.state === "success" ? `${ci.runs.length} workflow(s) pasaron.` : failed.map((r) => r.name).join(", ");
    toast(`${title}: ${body}`, ci.state === "success" ? "info" : "error");
    void import("./bridge").then(({ notify }) => notify(title, body));
  }
}

/* ------------------------------------------------------------------ */
/* Ramas                                                               */
/* ------------------------------------------------------------------ */

/** HEAD se movió (checkout, merge…): historial, PR, CI, stash y árbol se recargan. */
function afterHeadMove() {
  exitAmend();
  const { viewer, tree, isOpen, tab } = project();
  // La salida de un comando no depende de HEAD: se queda abierta.
  if (viewer && viewer.kind !== "file" && viewer.kind !== "output") project().set({ viewer: null });
  project().set({ logHead: null, openCommit: null });
  if (isOpen && tab === "history") void loadLog(true);
  for (const [dir, node] of Object.entries(tree)) if (Array.isArray(node)) void loadDir(dir);
  void refreshPr();
  void refreshCi(true);
  void refreshStashes();
}

/** ⌘⇧B: panel de Cambios abierto y el selector de ramas desplegado. */
export function openBranchPicker() {
  const { repo, isOpen, tab, isBranchPickerOpen } = project();
  if (!repo) {
    toast("El panel activo no está dentro de un repositorio git.");
    return;
  }
  if (isBranchPickerOpen) {
    project().set({ isBranchPickerOpen: false });
    return;
  }
  if (!isOpen || tab !== "changes") openProject("changes");
  project().set({ isBranchPickerOpen: true });
}

interface SwitchOptions {
  create?: boolean;
  /** `origin/x` → rama local `x` que la sigue. */
  remote?: boolean;
}

export async function switchBranch(name: string, options: SwitchOptions = {}): Promise<boolean> {
  const root = project().repo?.root;
  if (!root || project().busy) return false;
  project().set({ busy: "branch" });
  try {
    await gitApi.switchBranch(root, name, Boolean(options.create), Boolean(options.remote));
    const local = options.remote ? name.replace(/^[^/]+\//, "") : name;
    toast(options.create ? `Rama ${name} creada desde ${project().status?.branch ?? "HEAD"}.` : `Ahora estás en ${local}.`);
    afterHeadMove();
    return true;
  } catch (err) {
    const text = errorText(err);
    if (text.includes("stash")) {
      useUiStore.getState().askConfirm({
        title: `¿Guardar tus cambios en el stash y cambiar a ${name}?`,
        body: "Tus cambios sin commitear (incluidos archivos nuevos) se guardan en el stash. Los recuperas desde Cambios → Stash.",
        confirmLabel: "Guardar y cambiar",
        onConfirm: () => void stashThenSwitch(name, options),
      });
    } else {
      toast(text, "error");
    }
    return false;
  } finally {
    project().set({ busy: null });
    void refreshStatus();
  }
}

async function stashThenSwitch(name: string, options: SwitchOptions) {
  const root = project().repo?.root;
  if (!root) return;
  try {
    await gitApi.stashPush(root, `termCode: antes de cambiar a ${name}`, true);
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }
  await switchBranch(name, options);
}

/* ------------------------------------------------------------------ */
/* Stash                                                               */
/* ------------------------------------------------------------------ */

export async function refreshStashes() {
  const root = project().repo?.root;
  if (!root) return;
  let stashes: StashEntry[] = [];
  try {
    stashes = await gitApi.stashList(root);
  } catch {
    // Repo a medio borrar o git ocupado: se reintenta en el próximo cambio.
  }
  if (project().repo?.root === root && JSON.stringify(stashes) !== JSON.stringify(project().stashes)) project().set({ stashes });
}

export function stashPush() {
  return withBusy("stash", async () => {
    const root = project().repo?.root;
    if (!root) return;
    await gitApi.stashPush(root, "", true);
    toast("Cambios guardados en el stash (archivos nuevos incluidos).");
    void refreshStashes();
  });
}

export function stashApply(entry: StashEntry, pop: boolean) {
  return withBusy("stash", async () => {
    const root = project().repo?.root;
    if (!root) return;
    try {
      await gitApi.stashAction(root, pop ? "pop" : "apply", entry.index);
      toast(pop ? "Stash aplicado y retirado." : "Stash aplicado (se conserva).");
    } finally {
      void refreshStashes();
    }
  });
}

export function stashDrop(entry: StashEntry) {
  useUiStore.getState().askConfirm({
    title: "¿Borrar esta entrada del stash?",
    body: `«${entry.message}». Lo que contiene se pierde.`,
    confirmLabel: "Borrar",
    onConfirm: () =>
      void withBusy("stash", async () => {
        const root = project().repo?.root;
        if (!root) return;
        await gitApi.stashAction(root, "drop", entry.index);
        void refreshStashes();
      }),
  });
}

/* ------------------------------------------------------------------ */
/* Conflictos y operaciones a medias                                   */
/* ------------------------------------------------------------------ */

const OPERATION_LABEL: Record<string, string> = {
  merge: "el merge",
  rebase: "el rebase",
  "cherry-pick": "el cherry-pick",
  revert: "el revert",
};

export const operationLabel = (op: string) => OPERATION_LABEL[op] ?? op;

export function finishOperation(abort: boolean) {
  const { repo, status } = project();
  const op = status?.operation;
  if (!repo || !op) return;
  const run = () =>
    void withBusy("resolve", async () => {
      await gitApi.finishOperation(repo.root, abort);
      toast(abort ? `Se canceló ${operationLabel(op)}.` : `Terminó ${operationLabel(op)}.`);
      afterHeadMove();
    });
  if (!abort) {
    run();
    return;
  }
  useUiStore.getState().askConfirm({
    title: `¿Cancelar ${operationLabel(op)}?`,
    body: "El repositorio vuelve a como estaba antes de empezar; lo que resolviste se pierde.",
    confirmLabel: "Cancelar operación",
    onConfirm: run,
  });
}

export async function openConflict(path: string) {
  const root = project().repo?.root;
  if (!root) return;
  project().set({ viewer: { kind: "conflict", path } });
  const stillOpen = () => {
    const viewer = project().viewer;
    return viewer?.kind === "conflict" && viewer.path === path;
  };
  try {
    const preview = await gitApi.read(root, path);
    if (!stillOpen()) return;
    if (preview.binary || preview.truncated) {
      project().set({
        viewer: {
          kind: "conflict",
          path,
          error: preview.binary
            ? "Archivo binario: elige una versión en la terminal (git checkout --ours / --theirs) y luego git add."
            : "El archivo es muy grande para el visor: resuélvelo en tu editor.",
        },
      });
      return;
    }
    project().set({ viewer: { kind: "conflict", path, text: preview.text } });
  } catch (err) {
    if (stillOpen()) project().set({ viewer: { kind: "conflict", path, error: errorText(err) } });
  }
}

/** Guarda el resultado, marca el archivo como resuelto y pasa al siguiente conflicto. */
export async function saveConflict(path: string, content: string) {
  const root = project().repo?.root;
  if (!root) return;
  const ok = await withBusy("resolve", async () => {
    await gitApi.resolveConflict(root, path, content);
    return true;
  });
  if (!ok) return;
  await refreshStatus();
  const next = project().status?.changes.find((c) => c.conflicted);
  if (next) {
    toast(`${path} resuelto. Siguiente: ${next.path}`);
    void openConflict(next.path);
    return;
  }
  closeViewer();
  const op = project().status?.operation;
  toast(op ? `Sin conflictos pendientes: ya puedes terminar ${operationLabel(op)} en Cambios.` : `${path} resuelto.`);
}

/* ------------------------------------------------------------------ */
/* Buscador de archivos (⌘P)                                           */
/* ------------------------------------------------------------------ */

let filesCache: { root: string; at: number; files: string[] } | null = null;

/** La última lista de este proyecto, aunque sea vieja: el buscador la muestra al instante mientras trae la nueva. */
export function cachedProjectFiles(): string[] | null {
  const root = projectRoot();
  return root && filesCache?.root === root ? filesCache.files : null;
}

/** `fresh`: sin caché (al abrir el buscador: un agente pudo crear archivos hace un segundo). */
export async function projectFiles({ fresh = false } = {}): Promise<string[]> {
  const root = projectRoot();
  if (!root) return [];
  if (!fresh && filesCache?.root === root && Date.now() - filesCache.at < 30_000) return filesCache.files;
  const files = await gitApi.files(root);
  filesCache = { root, at: Date.now(), files };
  return files;
}
