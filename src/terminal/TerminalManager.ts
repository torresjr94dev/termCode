import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface TerminalInstance {
  id: string;
  backendSessionId: number | null;
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLElement | null;
  onExitCallbacks: Set<(code: number | null) => void>;
}

async function ensureTauriReady(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if ((window as any).__TAURI_INTERNALS__) return true;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if ((window as any).__TAURI_INTERNALS__) return true;
  }
  return false;
}

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

class TerminalManager {
  private instances = new Map<string, TerminalInstance>();
  private sessionToInstanceId = new Map<number, string>();
  private unlistenExit: UnlistenFn | null = null;
  private isBroadcastEnabledFn: () => boolean = () => false;
  private onExitClosePane?: (instanceId: string) => void;
  private onTitleChange?: (instanceId: string, title: string) => void;
  private sizeListeners = new Set<() => void>();

  constructor() {
    this.initListeners();
  }

  public setStoreHooks(hooks: {
    isBroadcastEnabled: () => boolean;
    onExit: (instanceId: string) => void;
    onTitle: (instanceId: string, title: string) => void;
  }) {
    this.isBroadcastEnabledFn = hooks.isBroadcastEnabled;
    this.onExitClosePane = hooks.onExit;
    this.onTitleChange = hooks.onTitle;
  }

  /** Suscripción compatible con `useSyncExternalStore`. */
  public subscribeSize = (listener: () => void): (() => void) => {
    this.sizeListeners.add(listener);
    return () => this.sizeListeners.delete(listener);
  };

  public getSize(id: string | undefined): string {
    const term = id ? this.instances.get(id)?.term : undefined;
    return term ? `${term.cols}×${term.rows}` : "";
  }

  private async initListeners() {
    if (this.unlistenExit) return;
    const ready = await ensureTauriReady();
    if (!ready) return;

    try {
      this.unlistenExit = await listen<{ id: number; code: number | null }>(
        "pty-exit",
        (event) => {
          const { id, code } = event.payload;
          const instanceId = this.sessionToInstanceId.get(id);
          if (instanceId) {
            const instance = this.instances.get(instanceId);
            if (instance) {
              instance.onExitCallbacks.forEach((cb) => cb(code));
            }
            this.sessionToInstanceId.delete(id);
            if (this.onExitClosePane) {
              this.onExitClosePane(instanceId);
            }
          }
        }
      );
    } catch (e) {
      console.warn("[termCode] Failed to attach pty-exit listener:", e);
    }
  }

  public getOrCreate(id: string): TerminalInstance {
    let instance = this.instances.get(id);
    if (instance) {
      return instance;
    }

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      fontSize: 13,
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace, "Symbols Nerd Font"',
      lineHeight: 1.15,
      scrollback: 5000,
      theme: FOSFORO_THEME,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(webLinksAddon);
    term.unicode.activeVersion = "11";

    instance = {
      id,
      backendSessionId: null,
      term,
      fitAddon,
      searchAddon,
      container: null,
      onExitCallbacks: new Set(),
    };

    // Attach onData listener ONCE per instance
    term.onData((data) => {
      const isBroadcast = this.isBroadcastEnabledFn();
      if (isBroadcast) {
        this.broadcastWrite(data);
      } else if (instance!.backendSessionId !== null) {
        invoke("pty_write", { id: instance!.backendSessionId, data }).catch(console.error);
      }
    });

    // Attach onResize listener ONCE per instance
    term.onResize((size) => {
      this.sizeListeners.forEach((listener) => listener());
      if (instance!.backendSessionId !== null) {
        invoke("pty_resize", {
          id: instance!.backendSessionId,
          cols: size.cols,
          rows: size.rows,
        }).catch(console.error);
      }
    });

    // OSC 0/2: la shell (o el agente) bautiza el panel
    term.onTitleChange((title) => this.onTitleChange?.(id, title));

    this.instances.set(id, instance);
    return instance;
  }

  public broadcastWrite(data: string) {
    for (const [_, inst] of this.instances) {
      if (inst.backendSessionId !== null) {
        invoke("pty_write", { id: inst.backendSessionId, data }).catch(console.error);
      }
    }
  }

  public attach(
    id: string,
    container: HTMLElement,
    opts?: { cwd?: string; program?: string; args?: string[]; initialCommand?: string }
  ) {
    const instance = this.getOrCreate(id);
    if (instance.container === container) {
      this.fit(id);
      return;
    }

    instance.container = container;
    if (instance.term.element) {
      // Al dividir, React remonta el panel en un contenedor nuevo. `open()` no
      // re-ancla un terminal ya abierto: hay que mover su elemento a mano o el
      // panel original queda en blanco.
      container.replaceChildren(instance.term.element);
    } else {
      container.replaceChildren();
      instance.term.open(container);
      this.enableWebgl(instance.term);
    }

    // Initial fit after DOM layout calculation
    setTimeout(() => {
      this.fit(id);
      instance.term.focus();
    }, 50);

    // If session not spawned yet, spawn it now
    if (instance.backendSessionId === null) {
      this.spawnBackend(id, opts);
    }
  }

  public async spawnBackend(
    id: string,
    opts?: { cwd?: string; program?: string; args?: string[]; initialCommand?: string }
  ) {
    const instance = this.instances.get(id);
    if (!instance) return;

    await ensureTauriReady();

    const cols = Math.max(instance.term.cols || 80, 20);
    const rows = Math.max(instance.term.rows || 24, 5);

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (message) => {
      const bytes = new Uint8Array(message);
      instance.term.write(bytes);

      if (instance.backendSessionId !== null) {
        invoke("pty_ack", {
          id: instance.backendSessionId,
          bytes: bytes.byteLength,
        }).catch(() => {});
      }
    };

    try {
      const sessionId = await invoke<number>("pty_spawn", {
        options: {
          program: opts?.program ?? null,
          args: opts?.args ?? [],
          cwd: opts?.cwd ?? null,
          env: [],
          cols,
          rows,
        },
        onData: channel,
      });

      instance.backendSessionId = sessionId;
      this.sessionToInstanceId.set(sessionId, id);

      // Execute initial command if provided (e.g. claude, codex)
      if (opts?.initialCommand) {
        setTimeout(() => {
          invoke("pty_write", {
            id: sessionId,
            data: `${opts.initialCommand}\n`,
          }).catch(console.error);
        }, 150);
      }
    } catch (e) {
      console.error("[termCode] Failed to spawn PTY:", e);
      instance.term.writeln(`\r\n\x1b[31m[termCode] Error al iniciar PTY: ${e}\x1b[0m\r\n`);
    }
  }

  /**
   * WebGL dibuja los caracteres de caja (╭─│) como glifos propios que ocupan la
   * celda completa: sin él, los TUI de Claude Code/Codex muestran huecos entre
   * filas. Si el contexto se pierde (límite de contextos del navegador), xterm
   * vuelve solo al renderer DOM.
   */
  private enableWebgl(term: Terminal) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("[termCode] WebGL no disponible, se usa el renderer DOM:", err);
    }
  }

  public fit(id: string) {
    const instance = this.instances.get(id);
    if (!instance || !instance.container) return;
    if (instance.container.clientWidth < 10 || instance.container.clientHeight < 10) return;
    try {
      instance.fitAddon.fit();
    } catch (err) {
      console.warn("[termCode] fit error:", err);
    }
  }

  public fitAll() {
    for (const [id] of this.instances) {
      this.fit(id);
    }
  }

  public focus(id: string) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.term.focus();
    }
  }

  public kill(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;

    if (instance.backendSessionId !== null) {
      invoke("pty_kill", { id: instance.backendSessionId }).catch(() => {});
      this.sessionToInstanceId.delete(instance.backendSessionId);
    }

    instance.term.dispose();
    this.instances.delete(id);
    this.sizeListeners.forEach((listener) => listener());
  }

  public destroy() {
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }
    for (const [id] of this.instances) {
      this.kill(id);
    }
  }

  public onExit(id: string, cb: (code: number | null) => void) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.onExitCallbacks.add(cb);
    }
  }
}

export const terminalManager = new TerminalManager();
