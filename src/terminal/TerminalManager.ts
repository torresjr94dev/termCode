import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_TAURI } from "../lib/ipc";
import type { ProcessInfo } from "../types/layout";

export const FONT_SIZE = { min: 9, max: 24, default: 13 } as const;

/** Contextos WebGL vivos como máximo; los navegadores cortan alrededor de 16. */
const MAX_WEBGL_CONTEXTS = 10;

/**
 * Paleta ANSI "Fósforo": cálida y desaturada, pensada para el fondo grafito.
 * El slot `cyan` es obligatorio en ANSI (los programas lo usan); aquí es un
 * verde verdigris apagado, no un cian neón.
 */
const FOSFORO_THEME = {
  background: "#0f0e0c",
  foreground: "#e6dfd2",
  cursor: "#ffb224",
  cursorAccent: "#0f0e0c",
  selectionBackground: "rgba(255, 178, 36, 0.24)",
  selectionInactiveBackground: "rgba(236, 230, 218, 0.08)",
  black: "#1f1d1a",
  red: "#e5604a",
  green: "#a3b865",
  yellow: "#e8b04b",
  blue: "#7e9cc8",
  magenta: "#c58fb5",
  cyan: "#86b3a4",
  white: "#d9d2c5",
  brightBlack: "#7a7367",
  brightRed: "#ff8a73",
  brightGreen: "#c2d686",
  brightYellow: "#ffcf70",
  brightBlue: "#a3bce0",
  brightMagenta: "#e0b0d2",
  brightCyan: "#a9d1c3",
  brightWhite: "#f7f2e8",
};

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
  container: HTMLElement | null;
  /** El PTY ya se pidió (evita un segundo spawn si React monta el panel dos veces). */
  spawnRequested: boolean;
  /** Bytes ya procesados por xterm y aún no confirmados al backend. */
  pendingAck: number;
  ackScheduled: boolean;
}

interface StoreHooks {
  isBroadcastEnabled: () => boolean;
  onExit: (paneId: string) => void;
  onTitle: (paneId: string, title: string) => void;
  /** BEL, OSC 9 u OSC 777: algo en el panel quiere atención. */
  onAttention: (paneId: string, kind: string, message: string) => void;
}

function openLink(event: MouseEvent, uri: string) {
  event.preventDefault();
  if (!/^https?:\/\//i.test(uri)) return;
  if (IS_TAURI) {
    // window.open() devuelve null dentro de Tauri: el plugin abre el navegador del sistema.
    openUrl(uri).catch((err) => console.warn("[termCode] no se pudo abrir el enlace:", err));
  } else {
    window.open(uri, "_blank", "noopener,noreferrer");
  }
}

class TerminalManager {
  private instances = new Map<string, TerminalInstance>();
  private sessionToInstanceId = new Map<number, string>();
  private webgl = new Map<string, WebglAddon>();
  private hooks: StoreHooks | null = null;
  private sizeListeners = new Set<() => void>();
  private fontSize: number = FONT_SIZE.default;

  constructor() {
    void this.listenForExits();
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
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      fontSize: this.fontSize,
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace, "Symbols Nerd Font"',
      lineHeight: 1.15,
      scrollback: 10_000,
      theme: FOSFORO_THEME,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 2000 });
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new WebLinksAddon(openLink));
    term.unicode.activeVersion = "11";

    const instance: TerminalInstance = {
      id,
      backendSessionId: null,
      term,
      fitAddon,
      searchAddon,
      container: null,
      spawnRequested: false,
      pendingAck: 0,
      ackScheduled: false,
    };

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
      if (/^\d+;/.test(data)) return false; // OSC 9;4 = barra de progreso, no notificación
      this.hooks?.onAttention(id, "notify", data);
      return true;
    });
    term.parser.registerOscHandler(777, (data) => {
      const [command, title = "", body = ""] = data.split(";");
      if (command !== "notify") return false;
      this.hooks?.onAttention(id, "notify", [title, body].filter(Boolean).join(": "));
      return true;
    });

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
    instance.term.dispose();
    this.instances.delete(id);
    this.sizeListeners.forEach((listener) => listener());
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
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

  public setFontSize(size: number) {
    this.fontSize = size;
    for (const instance of this.instances.values()) {
      instance.term.options.fontSize = size;
      this.fit(instance.id);
    }
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

  /** El PTY del panel ya arrancó (tiene sesión en el backend). */
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

  public getSelection(id: string): string {
    return this.instances.get(id)?.term.getSelection() ?? "";
  }

  /** Pega respetando el bracketed paste del programa (Claude Code, vim, zsh…). */
  public paste(id: string, text: string) {
    this.instances.get(id)?.term.paste(text);
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
}

export const terminalManager = new TerminalManager();
