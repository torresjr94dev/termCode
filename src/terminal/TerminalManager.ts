import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { ImageAddon } from "@xterm/addon-image";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { ProgressAddon, type IProgressState } from "@xterm/addon-progress";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_TAURI } from "../lib/ipc";
import { IS_MAC } from "../lib/shortcuts";
import { DEFAULT_SETTINGS, type Settings } from "../store/settingsStore";
import type { ProcessInfo } from "../types/layout";
import { CommandTracker, type CommandRecord } from "./commands";
import { fileLinkProvider, type FileLinkTarget } from "./links";
import { XTERM_THEMES } from "./themes";

export const FONT_SIZE = { min: 9, max: 24, default: DEFAULT_SETTINGS.fontSize } as const;

/** Contextos WebGL vivos como máximo; los navegadores cortan alrededor de 16. */
const MAX_WEBGL_CONTEXTS = 10;

const SEARCH_DECORATIONS: ISearchOptions["decorations"] = {
  matchBackground: "#3b3426",
  matchBorder: "#7a6534",
  matchOverviewRuler: "#7a6534",
  activeMatchBackground: "#ffb224",
  activeMatchBorder: "#ffcf70",
  activeMatchColorOverviewRuler: "#ffb224",
};

export interface SpawnSpec {
  cwd?: string;
  /** Línea de comandos que corre la shell de login (agentes). */
  command?: string;
}

interface TerminalInstance {
  id: string;
  backendSessionId: number | null;
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  tracker: CommandTracker;
  progress: IProgressState;
  container: HTMLElement | null;
  /** El PTY ya se pidió (evita un segundo spawn si React monta el panel dos veces). */
  spawnRequested: boolean;
  /** Bytes ya procesados por xterm y aún no confirmados al backend. */
  pendingAck: number;
  ackScheduled: boolean;
  dispose: Array<() => void>;
}

interface StoreHooks {
  isBroadcastEnabled: () => boolean;
  onExit: (paneId: string) => void;
  onTitle: (paneId: string, title: string) => void;
  /** BEL, OSC 9 u OSC 777: algo en el panel quiere atención. */
  onAttention: (paneId: string, kind: string, message: string) => void;
  /** Terminó un comando (integración con la shell). */
  onCommandFinished: (paneId: string, record: CommandRecord) => void;
  /** La shell avisó de un cambio de carpeta (OSC 7). */
  onCwd: (paneId: string, cwd: string) => void;
  /** ⌘-clic en una ruta de archivo de la salida. */
  onOpenPath: (target: FileLinkTarget) => void;
}

/** ⌘-clic (Ctrl-clic fuera de macOS): un clic normal selecciona texto, no abre cosas. */
const hasLinkModifier = (event: MouseEvent) => (IS_MAC ? event.metaKey : event.ctrlKey);

function openWebLink(event: MouseEvent, uri: string) {
  if (!hasLinkModifier(event) || !/^https?:\/\//i.test(uri)) return;
  event.preventDefault();
  if (IS_TAURI) {
    // window.open() devuelve null dentro de Tauri: el plugin abre el navegador del sistema.
    openUrl(uri).catch((err) => console.warn("[termCode] no se pudo abrir el enlace:", err));
  } else {
    window.open(uri, "_blank", "noopener,noreferrer");
  }
}

/**
 * OSC 52: los programas pueden *escribir* en el portapapeles (copiar desde
 * SSH/tmux) pero nunca leerlo: leer tu portapapeles a escondidas es un riesgo.
 */
const writeOnlyClipboard: IClipboardProvider = {
  readText: () => "",
  writeText: (_selection, text) => navigator.clipboard.writeText(text).catch(() => {}),
};

function terminalOptions(s: Settings) {
  return {
    fontSize: s.fontSize,
    fontFamily: `${s.fontFamily}, "Symbols Nerd Font"`,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    screenReaderMode: s.screenReader,
    theme: XTERM_THEMES[s.theme],
  };
}

class TerminalManager {
  private instances = new Map<string, TerminalInstance>();
  private sessionToInstanceId = new Map<number, string>();
  private webgl = new Map<string, WebglAddon>();
  private hooks: StoreHooks | null = null;
  private sizeListeners = new Set<() => void>();
  private progressListeners = new Set<() => void>();
  private settings: Settings = DEFAULT_SETTINGS;
  private home: string | null = null;

  constructor() {
    void this.listenForExits();
    if (IS_TAURI) {
      void import("@tauri-apps/api/path")
        .then(({ homeDir }) => homeDir())
        .then((home) => (this.home = home))
        .catch(() => {});
    }
  }

  public setStoreHooks(hooks: StoreHooks) {
    this.hooks = hooks;
  }

  /* ------------------------------------------------------------------ */
  /* Ciclo de vida                                                       */
  /* ------------------------------------------------------------------ */

  private async listenForExits() {
    if (!IS_TAURI) return;
    try {
      await listen<{ id: number; code: number | null }>("pty-exit", (event) => {
        const paneId = this.sessionToInstanceId.get(event.payload.id);
        if (!paneId) return;
        this.sessionToInstanceId.delete(event.payload.id);
        this.hooks?.onExit(paneId);
      });
    } catch (err) {
      console.warn("[termCode] no se pudo escuchar pty-exit:", err);
    }
  }

  private getOrCreate(id: string): TerminalInstance {
    const existing = this.instances.get(id);
    if (existing) return existing;

    const term = new Terminal({
      allowProposedApi: true,
      cursorInactiveStyle: "outline",
      ...terminalOptions(this.settings),
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 2000 });
    const progressAddon = new ProgressAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new WebLinksAddon(openWebLink));
    term.loadAddon(new ClipboardAddon(undefined, writeOnlyClipboard));
    term.loadAddon(progressAddon);
    term.unicode.activeVersion = "11";

    const instance: TerminalInstance = {
      id,
      backendSessionId: null,
      term,
      fitAddon,
      searchAddon,
      tracker: new CommandTracker(
        term,
        (record) => this.hooks?.onCommandFinished(id, record),
        (cwd) => this.hooks?.onCwd(id, cwd),
      ),
      progress: { state: 0, value: 0 },
      container: null,
      spawnRequested: false,
      pendingAck: 0,
      ackScheduled: false,
      dispose: [],
    };
    instance.dispose.push(instance.tracker.attach());

    const progressSub = progressAddon.onChange((state) => {
      instance.progress = state;
      this.progressListeners.forEach((l) => l());
    });
    instance.dispose.push(() => progressSub.dispose());

    term.onData((data) => {
      if (this.hooks?.isBroadcastEnabled()) this.broadcast("pty_write", { data });
      else this.send(instance, "pty_write", { data });
    });
    // Bytes no UTF-8 (reportes de ratón antiguos): van tal cual, no como texto.
    term.onBinary((data) => {
      const bytes = Array.from(data, (c) => c.charCodeAt(0) & 0xff);
      if (this.hooks?.isBroadcastEnabled()) this.broadcast("pty_write_bytes", { data: bytes });
      else this.send(instance, "pty_write_bytes", { data: bytes });
    });

    term.onResize(({ cols, rows }) => {
      this.sizeListeners.forEach((listener) => listener());
      this.send(instance, "pty_resize", { cols, rows });
    });

    // OSC 0/2: la shell (o el agente) bautiza el panel.
    term.onTitleChange((title) => this.hooks?.onTitle(id, title));

    // Señales de "necesito atención": BEL, OSC 9 (iTerm2) y OSC 777 (notify;título;cuerpo).
    term.onBell(() => this.hooks?.onAttention(id, "bell", ""));
    term.parser.registerOscHandler(9, (data) => {
      if (/^\d+;/.test(data)) return false; // OSC 9;4 = barra de progreso (la maneja su addon)
      this.hooks?.onAttention(id, "notify", data);
      return true;
    });
    term.parser.registerOscHandler(777, (data) => {
      const [command, title = "", body = ""] = data.split(";");
      if (command !== "notify") return false;
      this.hooks?.onAttention(id, "notify", [title, body].filter(Boolean).join(": "));
      return true;
    });

    term.registerLinkProvider(
      fileLinkProvider(
        term,
        () => ({ cwd: instance.tracker.cwd, home: this.home }),
        (target, event) => {
          if (hasLinkModifier(event)) this.hooks?.onOpenPath(target);
        },
      ),
    );

    this.instances.set(id, instance);
    return instance;
  }

  public attach(id: string, container: HTMLElement, spec: SpawnSpec) {
    const instance = this.getOrCreate(id);
    if (instance.container === container) {
      this.fit(id);
      return;
    }

    instance.container = container;
    if (instance.term.element) {
      // Al dividir, React remonta el panel en un contenedor nuevo. `open()` no
      // re-ancla un terminal ya abierto: hay que mover su elemento a mano.
      container.replaceChildren(instance.term.element);
    } else {
      container.replaceChildren();
      instance.term.open(container);
      this.enableWebgl(id);
      // Imágenes en línea (sixel e iTerm2): con límites de memoria razonables.
      instance.term.loadAddon(new ImageAddon({ pixelLimit: 16_777_216, storageLimit: 64, sixelSupport: true, iipSupport: true }));
    }

    requestAnimationFrame(() => {
      this.fit(id);
      instance.term.focus();
    });

    if (!instance.spawnRequested) {
      instance.spawnRequested = true;
      void this.spawn(instance, spec);
    }
  }

  private async spawn(instance: TerminalInstance, spec: SpawnSpec) {
    if (!IS_TAURI) return;
    const { term } = instance;

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (message) => {
      const bytes = new Uint8Array(message);
      // El ack va cuando xterm *procesó* los bytes, no cuando llegaron: así el
      // backpressure del backend frena al proceso antes de saturar el parser.
      term.write(bytes, () => this.queueAck(instance, bytes.byteLength));
    };

    try {
      const sessionId = await invoke<number>("pty_spawn", {
        options: {
          program: null,
          command: spec.command ?? null,
          args: [],
          cwd: spec.cwd ?? null,
          env: [["TERMCODE_PANE_ID", instance.id]],
          cols: Math.max(term.cols || 80, 20),
          rows: Math.max(term.rows || 24, 5),
        },
        onData: channel,
        shellIntegration: this.settings.shellIntegration,
      });
      instance.backendSessionId = sessionId;
      this.sessionToInstanceId.set(sessionId, instance.id);
      // Lo que se procesó antes de conocer el id también se confirma.
      this.flushAck(instance);
      // El tamaño pudo cambiar mientras el PTY arrancaba.
      this.send(instance, "pty_resize", { cols: term.cols, rows: term.rows });
    } catch (err) {
      console.error("[termCode] no se pudo iniciar el PTY:", err);
      term.writeln(`\r\n\x1b[31m[termCode] Error al iniciar el PTY: ${String(err)}\x1b[0m\r\n`);
    }
  }

  /** Agrupa los acks de una ráfaga de escrituras en una sola llamada IPC. */
  private queueAck(instance: TerminalInstance, bytes: number) {
    instance.pendingAck += bytes;
    if (instance.ackScheduled) return;
    instance.ackScheduled = true;
    // Microtarea y no rAF: rAF se pausa con la ventana oculta y congelaría el proceso.
    queueMicrotask(() => {
      instance.ackScheduled = false;
      this.flushAck(instance);
    });
  }

  private flushAck(instance: TerminalInstance) {
    if (instance.backendSessionId === null || instance.pendingAck === 0) return;
    const bytes = instance.pendingAck;
    instance.pendingAck = 0;
    invoke("pty_ack", { id: instance.backendSessionId, bytes }).catch(() => {});
  }

  private send(instance: TerminalInstance, command: string, args: Record<string, unknown>) {
    if (instance.backendSessionId === null) return;
    invoke(command, { id: instance.backendSessionId, ...args }).catch((err) =>
      console.warn(`[termCode] ${command}:`, err),
    );
  }

  private broadcast(command: string, args: Record<string, unknown>) {
    for (const instance of this.instances.values()) this.send(instance, command, args);
  }

  public kill(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    if (instance.backendSessionId !== null) {
      invoke("pty_kill", { id: instance.backendSessionId }).catch(() => {});
      this.sessionToInstanceId.delete(instance.backendSessionId);
    }
    this.webgl.get(id)?.dispose();
    this.webgl.delete(id);
    instance.dispose.forEach((fn) => fn());
    instance.tracker.dispose();
    instance.term.dispose();
    this.instances.delete(id);
    this.sizeListeners.forEach((listener) => listener());
  }

  /* ------------------------------------------------------------------ */
  /* Render y ajustes                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * WebGL dibuja los caracteres de caja (╭─│) ocupando la celda completa: sin
   * él, los TUI de Claude Code/Codex muestran huecos entre filas. Si el
   * contexto se pierde, xterm vuelve solo al renderer DOM.
   */
  private enableWebgl(id: string) {
    const instance = this.instances.get(id);
    if (!instance?.term.element || this.webgl.has(id)) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        this.webgl.delete(id);
      });
      instance.term.loadAddon(addon);
      this.webgl.set(id, addon);
    } catch (err) {
      console.warn("[termCode] WebGL no disponible, se usa el renderer DOM:", err);
    }
  }

  /**
   * Los paneles visibles usan WebGL; si hay demasiados contextos, los de
   * pestañas ocultas vuelven al renderer DOM (se recuperan al mostrarse).
   */
  public syncRenderers(visible: ReadonlySet<string>) {
    for (const id of visible) this.enableWebgl(id);
    let excess = this.webgl.size - MAX_WEBGL_CONTEXTS;
    for (const [id, addon] of this.webgl) {
      if (excess <= 0) break;
      if (visible.has(id)) continue;
      addon.dispose();
      this.webgl.delete(id);
      excess--;
    }
  }

  public applySettings(settings: Settings) {
    this.settings = settings;
    const options = terminalOptions(settings);
    for (const instance of this.instances.values()) {
      Object.assign(instance.term.options, options);
      this.fit(instance.id);
    }
  }

  public fit(id: string) {
    const instance = this.instances.get(id);
    const container = instance?.container;
    if (!instance || !container || container.clientWidth < 10 || container.clientHeight < 10) return;
    try {
      instance.fitAddon.fit();
    } catch (err) {
      console.warn("[termCode] fit:", err);
    }
  }

  public focus(id: string) {
    this.instances.get(id)?.term.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Consultas y utilidades para la UI                                  */
  /* ------------------------------------------------------------------ */

  /** Suscripción compatible con `useSyncExternalStore`. */
  public subscribeSize = (listener: () => void): (() => void) => {
    this.sizeListeners.add(listener);
    return () => this.sizeListeners.delete(listener);
  };

  public getSize(id: string | undefined): string {
    const term = id ? this.instances.get(id)?.term : undefined;
    return term ? `${term.cols}×${term.rows}` : "";
  }

  public subscribeProgress = (listener: () => void): (() => void) => {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  };

  public getProgress(id: string): IProgressState {
    return this.instances.get(id)?.progress ?? { state: 0, value: 0 };
  }

  public getTracker(id: string): CommandTracker | undefined {
    return this.instances.get(id)?.tracker;
  }

  public getTerminal(id: string): Terminal | undefined {
    return this.instances.get(id)?.term;
  }

  public isSpawned(id: string): boolean {
    return (this.instances.get(id)?.backendSessionId ?? null) !== null;
  }

  public async info(id: string): Promise<ProcessInfo | null> {
    const sessionId = this.instances.get(id)?.backendSessionId;
    if (sessionId === null || sessionId === undefined) return null;
    try {
      return await invoke<ProcessInfo>("pty_info", { id: sessionId });
    } catch {
      return null;
    }
  }

  /** Carpeta conocida sin preguntar al backend (OSC 7). */
  public knownCwd(id: string): string | null {
    return this.instances.get(id)?.tracker.cwd ?? null;
  }

  public getSelection(id: string): string {
    return this.instances.get(id)?.term.getSelection() ?? "";
  }

  /** Pega respetando el bracketed paste del programa (Claude Code, vim, zsh…). */
  public paste(id: string, text: string) {
    this.instances.get(id)?.term.paste(text);
  }

  /** Escribe y ejecuta (Enter) una línea en la shell del panel. */
  public run(id: string, line: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    this.send(instance, "pty_write", { data: `${line}\r` });
    instance.term.focus();
  }

  /** ⌘↑ / ⌘↓: salta al comando anterior/siguiente. */
  public jumpToCommand(id: string, direction: -1 | 1): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;
    const { term, tracker } = instance;
    const top = term.buffer.active.viewportY;
    const target = tracker.neighbour(direction < 0 ? top : top + 1, direction);
    if (!target) {
      if (direction > 0) term.scrollToBottom();
      return false;
    }
    term.scrollToLine(tracker.anchorLine(target));
    return true;
  }

  /** `incremental`: mientras se escribe, la coincidencia actual se amplía en vez de saltar. */
  public find(
    id: string,
    query: string,
    opts: { backwards?: boolean; caseSensitive?: boolean; incremental?: boolean } = {},
  ) {
    const search = this.instances.get(id)?.searchAddon;
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      return;
    }
    const options: ISearchOptions = { caseSensitive: opts.caseSensitive, decorations: SEARCH_DECORATIONS };
    if (opts.backwards) search.findPrevious(query, options);
    else search.findNext(query, { ...options, incremental: opts.incremental });
  }

  public onSearchResults(id: string, listener: (index: number, count: number) => void): () => void {
    const search = this.instances.get(id)?.searchAddon;
    if (!search) return () => {};
    const sub = search.onDidChangeResults(({ resultIndex, resultCount }) => listener(resultIndex, resultCount));
    return () => sub.dispose();
  }

  public clearSearch(id: string) {
    this.instances.get(id)?.searchAddon.clearDecorations();
  }

  /** Últimas líneas visibles del panel, en texto (miniaturas de la vista general). */
  public snapshot(id: string, rows: number): string[] {
    const term = this.instances.get(id)?.term;
    if (!term) return [];
    const buffer = term.buffer.active;
    const end = buffer.baseY + buffer.cursorY + 1;
    const lines: string[] = [];
    for (let y = Math.max(0, end - rows); y < end; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return lines;
  }
}

export const terminalManager = new TerminalManager();
