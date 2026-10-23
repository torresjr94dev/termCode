import { LazyStore } from "@tauri-apps/plugin-store";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { useTerminalStore } from "../store/terminalStore";
import { settingsNow } from "../store/settingsStore";
import { terminalManager } from "../terminal/TerminalManager";
import { IS_TAURI } from "./ipc";
import { collectPanes } from "./layout";

/**
 * Lo que había en cada terminal, para que al reabrir no vuelvan vacías. Va en
 * su propio archivo (no en la sesión: es mucho más grande) y con topes: las
 * últimas líneas de cada panel y un máximo total.
 */
const KEY = "buffers";
const LINES = 1000;
const MAX_PER_PANE = 400_000;
const MAX_TOTAL = 4_000_000;
const SAVE_EVERY_MS = 30_000;

const store = IS_TAURI ? new LazyStore("buffers.json", { defaults: {}, autoSave: false }) : null;

interface SavedBuffers {
  version: 1;
  panes: Record<string, { text: string; at: number }>;
}

/** Lo que llega del disco: solo textos válidos y de un tamaño razonable. */
export function sanitizeBuffers(input: unknown): SavedBuffers["panes"] {
  const raw = input as Partial<SavedBuffers> | null;
  if (!raw || raw.version !== 1 || !raw.panes || typeof raw.panes !== "object") return {};
  const out: SavedBuffers["panes"] = {};
  for (const [id, entry] of Object.entries(raw.panes)) {
    if (typeof id !== "string" || id.length > 100) continue;
    if (typeof entry?.text !== "string" || typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
    out[id] = { text: entry.text.slice(-MAX_PER_PANE), at: entry.at };
  }
  return out;
}

/** Recorta al tope total: se queda con los paneles más recientes. */
export function capBuffers(panes: SavedBuffers["panes"], max = MAX_TOTAL): SavedBuffers["panes"] {
  const entries = Object.entries(panes).sort(([, a], [, b]) => b.at - a.at);
  const out: SavedBuffers["panes"] = {};
  let total = 0;
  for (const [id, entry] of entries) {
    const text = entry.text.slice(-MAX_PER_PANE);
    if (total + text.length > max) continue;
    total += text.length;
    out[id] = { text, at: entry.at };
  }
  return out;
}

/**
 * Lo último guardado de cada panel: solo se vuelve a serializar el que
 * recibió salida desde entonces (serializar 1000 líneas cuesta, y en el hilo
 * de la interfaz).
 */
const saved = new Map<string, { text: string; at: number }>();

/** Al arrancar: los paneles restaurados vuelven con su contenido. */
export async function loadBuffers(timeoutMs = 800): Promise<void> {
  if (!store || !settingsNow().restoreScrollback) return;
  try {
    const raw = await Promise.race([store.get<SavedBuffers>(KEY), new Promise<undefined>((r) => setTimeout(r, timeoutMs))]);
    const panes = sanitizeBuffers(raw);
    const alive = new Set(useTerminalStore.getState().tabs.flatMap((t) => collectPanes(t.root).map((p) => p.id)));
    const restored = Object.fromEntries(Object.entries(panes).filter(([id]) => alive.has(id)));
    // Si un panel restaurado no imprime nada nuevo, se conserva lo que traía.
    for (const [id, entry] of Object.entries(restored)) saved.set(id, entry);
    terminalManager.setRestore(restored);
  } catch (err) {
    console.warn("[termCode] no se pudo leer el contenido guardado de las terminales:", err);
  }
}

/** Cede el hilo entre panel y panel: un guardado nunca congela la interfaz de un tirón. */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let saving = false;

async function saveBuffers() {
  if (!store || saving) return;
  saving = true;
  try {
    if (!settingsNow().restoreScrollback) {
      if (!saved.size) return;
      saved.clear();
      await store.set(KEY, { version: 1, panes: {} } satisfies SavedBuffers);
      await store.save();
      return;
    }
    const ids = useTerminalStore.getState().tabs.flatMap((t) => collectPanes(t.root).map((p) => p.id));
    const open = new Set(ids);
    let changed = false;
    for (const id of [...saved.keys()]) {
      if (!open.has(id)) changed = saved.delete(id) || changed;
    }
    for (const id of terminalManager.takeDirty(ids)) {
      await yieldToUi();
      const text = terminalManager.serialize(id, LINES);
      if (text) saved.set(id, { text, at: Date.now() });
      else saved.delete(id);
      changed = true;
    }
    if (!changed) return;
    await store.set(KEY, { version: 1, panes: capBuffers(Object.fromEntries(saved)) } satisfies SavedBuffers);
    await store.save();
  } catch (err) {
    void logWarn(`[webview] no se pudo guardar el contenido de las terminales: ${String(err)}`).catch(() => {});
  } finally {
    saving = false;
  }
}

/** Cada 30 s y al ocultar la ventana; solo lo que cambió, un panel a la vez. */
export function startBufferAutosave(): () => void {
  if (!store) return () => {};
  const interval = setInterval(() => void saveBuffers(), SAVE_EVERY_MS);
  const onHide = () => {
    if (document.visibilityState === "hidden") void saveBuffers();
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onHide);
  };
}
