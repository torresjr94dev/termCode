import { Terminal, type IWindowsPty } from "@xterm/xterm";
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
import { IS_MAC, IS_WINDOWS } from "../lib/shortcuts";
import { DEFAULT_SETTINGS, type Settings } from "../store/settingsStore";
import type { ProcessInfo } from "../types/layout";
import { CommandTracker, withShellFacts, type CommandRecord } from "./commands";
import { fileLinkProvider, type FileLinkTarget } from "./links";
import { sanitizePaste } from "./paste";
import { indexAfterClear } from "./clear";
import { XTERM_THEMES } from "./themes";

export const FONT_SIZE = { min: 9, max: 24, default: DEFAULT_SETTINGS.fontSize } as const;

/** Contextos WebGL vivos como máximo; los navegadores cortan alrededor de 16. */
const MAX_WEBGL_CONTEXTS = 10;

/** Escrituras que se guardan mientras el PTY arranca (con tope: nadie teclea tanto tan rápido). */
const MAX_PENDING_INPUT = 256;
const INPUT_COMMANDS = new Set(["pty_write", "pty_write_bytes"]);

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
  /** Escribir la bienvenida antes de arrancar la shell (pestañas nuevas). */
  welcome?: boolean;
}

/** Medidas vivas del panel para la tarjeta de bienvenida (se reacomoda al redimensionar). */
export interface WelcomeView {
  /** Ancho útil de la terminal, en píxeles. */
  width: () => number;
  onResize: (listener: () => void) => () => void;
}

/**
 * Bienvenida de una pestaña nueva: una tarjeta real anclada a unas líneas en
 * blanco (no se deforma al dividir, porque una línea vacía no tiene nada que
 * partirse) o, con lector de pantalla, una línea de texto.
 */
export type WelcomeContent =
  | { kind: "text"; text: string }
  | { kind: "card"; height: number; mount: (host: HTMLElement, view: WelcomeView) => () => void };

/** El próximo frame, o poco después si la ventana no está pintando (rAF en pausa). */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 80);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });

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
  /** Lo que xterm o el usuario escribieron antes de conocer el id de la sesión. */
  pendingInput: Array<{ command: string; args: Record<string, unknown> }>;
  /** Shell (no agente): tras `clear` vuelve a dar la bienvenida. */
  isShell: boolean;
  /** La tarjeta de bienvenida visible (una a la vez). */
  welcomeCard: { dispose: () => void } | null;
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
  /** Bienvenida para un panel de ese tamaño (`null` = no cabe o está desactivada). */
  renderWelcome: (paneId: string, size: { cols: number; rows: number; height: number; width: number }) => WelcomeContent | null;
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

/** `c` o `v` del evento, también con layouts que no son latinos (Ctrl+С en cirílico). */
function letterOf(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  return /^[a-z]$/.test(key) ? key : e.code.replace(/^Key/, "").toLowerCase();
}

/**
 * Fuera de macOS no hay ⌘: copiar y pegar son Ctrl, como en Windows Terminal.
 * Ctrl+C copia si hay selección (si no, es ^C para la shell), Ctrl+Shift+C
 * siempre copia, y Ctrl+V / Ctrl+Shift+V pegan por el evento `paste` nativo,
 * igual que ⌘V en macOS (xterm añade el bracketed paste). AltGr llega como
 * Ctrl+Alt y escribe caracteres (@, #, [): nunca es un atajo.
 * Devuelve `false` cuando xterm no debe procesar la tecla.
 */
function handleClipboardKey(term: Terminal, e: KeyboardEvent): boolean {
  if (IS_MAC || e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey || e.getModifierState("AltGraph")) return true;
  const letter = letterOf(e);
  if (letter === "c" && (e.shiftKey || term.hasSelection())) {
    const text = term.getSelection();
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
    term.clearSelection();
    e.preventDefault();
    return false;
  }
  // Sin preventDefault: el navegador dispara `paste` sobre la textarea de xterm.
  return letter !== "v";
}

/**
 * Con glass (Neón en la ventana de macOS) el fondo de xterm es transparente:
 * el velo lo pone el panel por CSS, así hay una sola capa sobre el escritorio.
 */
function terminalTheme(s: Settings) {
  const theme = XTERM_THEMES[s.theme];
  const glass = s.theme === "neon" && typeof document !== "undefined" && document.documentElement.dataset.glass === "on";
  return glass ? { ...theme, background: "#00000000" } : theme;
}

function terminalOptions(s: Settings) {
  return {
    fontSize: s.fontSize,
    fontFamily: `${s.fontFamily}, "Symbols Nerd Font"`,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    screenReaderMode: s.screenReader,
    theme: terminalTheme(s),
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
  /**
   * Con ConPTY, xterm no debe subir historial a la vista al crecer el panel
   * (ConPTY repinta su pantalla encima y se duplican líneas), y antes de la
   * build 21376 de Windows tampoco debe reacomodar líneas al cambiar el ancho.
   */
  private windowsPty: IWindowsPty | undefined = IS_WINDOWS ? { backend: "conpty" } : undefined;

  constructor() {
    void this.listenForExits();
    if (IS_TAURI) {
      void import("@tauri-apps/api/path")
        .then(({ homeDir }) => homeDir())
        .then((home) => (this.home = home))
        .catch(() => {});
    }
    if (IS_TAURI && IS_WINDOWS) {
      void invoke<number | null>("windows_build")
        .then((buildNumber) => {
          if (!buildNumber) return;
          this.windowsPty = { backend: "conpty", buildNumber };
          for (const instance of this.instances.values()) instance.term.options.windowsPty = this.windowsPty;
        })
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
      // Solo se puede fijar al crear: sin esto no hay fondo transparente si luego cambias a Neón.
      allowTransparency: true,
      cursorInactiveStyle: "outline",
      ...(this.windowsPty ? { windowsPty: this.windowsPty } : {}),
      ...terminalOptions(this.settings),
    });
    term.attachCustomKeyEventHandler((e) => handleClipboardKey(term, e));

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
      pendingInput: [],
      isShell: false,
      welcomeCard: null,
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
      instance.isShell = !spec.command;
      if (spec.welcome) void this.welcomeThenSpawn(instance, spec);
      else void this.spawn(instance, spec);
    }
  }

  /**
   * La bienvenida va antes que cualquier byte de la shell: se mide el panel,
   * se escribe y solo entonces arranca el PTY (ya con su tamaño real). Nunca
   * pasa por el PTY: la shell no la ve y los agentes que leen paneles tampoco.
   */
  private async welcomeThenSpawn(instance: TerminalInstance, spec: SpawnSpec) {
    await nextFrame();
    // Se cerró mientras esperaba el frame: no hay shell que arrancar.
    if (this.instances.get(instance.id) !== instance) return;
    this.fit(instance.id);
    await this.showWelcome(instance);
    await this.spawn(instance, spec);
  }

  /** Pone la bienvenida en la posición actual del cursor (al abrir el panel o tras `clear`). */
  private showWelcome(instance: TerminalInstance): Promise<void> {
    try {
      const screen = instance.term.element?.querySelector<HTMLElement>(".xterm-screen");
      const size = { cols: instance.term.cols, rows: instance.term.rows, height: screen?.clientHeight ?? 0, width: screen?.clientWidth ?? 0 };
      const welcome = this.hooks?.renderWelcome(instance.id, size);
      if (welcome?.kind === "text") instance.term.write(welcome.text);
      else if (welcome?.kind === "card") return this.mountWelcomeCard(instance, welcome);
    } catch (err) {
      // Una bienvenida rota nunca puede dejar el panel sin shell.
      console.warn("[termCode] bienvenida:", err);
    }
    return Promise.resolve();
  }

  /**
   * Salida de la shell hacia xterm. Si es un `clear` (borra el historial) en
   * una shell, la tarjeta vuelve justo después del borrado y antes del prompt:
   * misma pantalla limpia de cuando abriste el panel, sin saltos.
   */
  private receive(instance: TerminalInstance, bytes: Uint8Array) {
    const { term } = instance;
    const ack = (n: number) => () => this.queueAck(instance, n);
    const cut = instance.isShell && term.buffer.active.type === "normal" ? indexAfterClear(bytes) : -1;
    if (cut < 0) {
      term.write(bytes, ack(bytes.byteLength));
      return;
    }
    term.write(bytes.subarray(0, cut), ack(cut));
    // `showWelcome` encola sus líneas en xterm ya: el resto de la salida va detrás, en orden.
    void this.showWelcome(instance);
    term.write(bytes.subarray(cut), ack(bytes.byteLength - cut));
  }

  /** Para pruebas sin backend: salida como si viniera de la shell del panel. */
  public receiveForTesting(id: string, text: string) {
    const instance = this.instances.get(id);
    if (instance) this.receive(instance, new TextEncoder().encode(text));
  }

  /**
   * Reserva `rows + 1` líneas en blanco y ancla a la primera una decoración de
   * xterm donde vive la tarjeta. Se desplaza con el historial y desaparece
   * con él (`clear`, recorte del scrollback o al cerrar el panel).
   */
  private mountWelcomeCard(instance: TerminalInstance, card: Extract<WelcomeContent, { kind: "card" }>): Promise<void> {
    const { term } = instance;
    const screenHeight = term.element?.querySelector<HTMLElement>(".xterm-screen")?.clientHeight ?? 0;
    const cell = term.rows ? screenHeight / term.rows : 0;
    // Filas que ocupa la tarjeta con la letra actual (más una de aire antes del prompt).
    const rows = Math.max(2, Math.ceil(card.height / (cell || 15)));
    const reserved = rows + 1;
    // Una sola a la vez: si la anterior sigue (p. ej. su línea solo se borró), se retira.
    instance.welcomeCard?.dispose();
    instance.welcomeCard = null;
    return new Promise((resolve) => {
      term.write("\r\n".repeat(reserved), () => {
        try {
          const marker = term.registerMarker(-reserved);
          const decoration = marker ? term.registerDecoration({ marker, height: rows, width: 1, layer: "top" }) : undefined;
          if (!decoration) return;
          instance.welcomeCard = decoration;
          const screen = () => term.element?.querySelector<HTMLElement>(".xterm-screen");
          const view: WelcomeView = {
            width: () => screen()?.clientWidth ?? 0,
            // Se observa el mismo nodo cuyo ancho se lee. `term.onResize` no basta: con el
            // render en pausa (el panel dejó de verse un instante, p. ej. al dividir), xterm
            // aplaza el cambio de `.xterm-screen` a una tarea en reposo, y la tarjeta leía el
            // ancho viejo sin que nada volviera a avisarle.
            onResize: (listener) => {
              const node = screen();
              if (!node) {
                const sub = term.onResize(() => requestAnimationFrame(listener));
                return () => sub.dispose();
              }
              const observer = new ResizeObserver(() => listener());
              observer.observe(node);
              return () => observer.disconnect();
            },
          };
          let unmount: (() => void) | null = null;
          decoration.onRender((element) => {
            if (unmount) return;
            element.classList.add("welcome-decoration");
            unmount = card.mount(element, view);
          });
          decoration.onDispose(() => {
            unmount?.();
            unmount = null;
            if (instance.welcomeCard === decoration) instance.welcomeCard = null;
          });
        } finally {
          resolve();
        }
      });
    });
  }

  private async spawn(instance: TerminalInstance, spec: SpawnSpec) {
    if (!IS_TAURI) return;
    const { term } = instance;

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (message) => {
      // El ack va cuando xterm *procesó* los bytes, no cuando llegaron: así el
      // backpressure del backend frena al proceso antes de saturar el parser.
      this.receive(instance, new Uint8Array(message));
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
      this.sessionToInstanceId.set(sessionId, instance.id);
      // En orden y antes que lo nuevo: hasta tener el id, `send` sigue encolando.
      while (instance.pendingInput.length) {
        const { command, args } = instance.pendingInput.shift()!;
        await invoke(command, { id: sessionId, ...args }).catch((err) => console.warn(`[termCode] ${command}:`, err));
      }
      // Se cerró el panel mientras arrancaba: su PTY no tiene quién lo lea.
      if (this.instances.get(instance.id) !== instance) {
        this.sessionToInstanceId.delete(sessionId);
        invoke("pty_kill", { id: sessionId }).catch(() => {});
        return;
      }
      instance.backendSessionId = sessionId;
      // Lo que se procesó antes de conocer el id también se confirma.
      this.flushAck(instance);
      // El tamaño pudo cambiar mientras el PTY arrancaba.
      this.send(instance, "pty_resize", { cols: term.cols, rows: term.rows });
    } catch (err) {
      instance.pendingInput = [];
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
    if (instance.backendSessionId === null) {
      // ConPTY pregunta dónde está el cursor (`ESC[6n`) al arrancar y no muestra
      // nada hasta que xterm contesta; esa respuesta puede salir antes de que
      // `pty_spawn` devuelva el id. Perderla dejaba el panel en blanco.
      if (instance.spawnRequested && INPUT_COMMANDS.has(command) && instance.pendingInput.length < MAX_PENDING_INPUT) {
        instance.pendingInput.push({ command, args });
      }
      return;
    }
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
    const instance = this.instances.get(id);
    const sessionId = instance?.backendSessionId;
    if (!instance || sessionId === null || sessionId === undefined) return null;
    try {
      const info = await invoke<ProcessInfo>("pty_info", { id: sessionId });
      return withShellFacts(info, instance.tracker, instance.isShell);
    } catch {
      return null;
    }
  }

  /** Carpeta de inicio del usuario (para mostrar rutas como `~/…`). */
  public getHome(): string | null {
    return this.home;
  }

  /** Carpeta conocida sin preguntar al backend (OSC 7). */
  public knownCwd(id: string): string | null {
    return this.instances.get(id)?.tracker.cwd ?? null;
  }

  public getSelection(id: string): string {
    return this.instances.get(id)?.term.getSelection() ?? "";
  }

  /**
   * Pega en *este* panel respetando el bracketed paste del programa (Claude
   * Code, vim, zsh…). Nunca pasa por broadcast: es texto dirigido a uno.
   * Sin caracteres de control: un `ESC[201~` dentro del texto (p. ej. una línea
   * citada de un archivo que escribió un agente) cerraría el pegado antes de
   * tiempo y lo que sigue se "teclearía" como comandos.
   */
  public paste(id: string, text: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    const clean = sanitizePaste(text);
    if (!clean) return;
    const data = instance.term.modes.bracketedPasteMode ? `\x1b[200~${clean}\x1b[201~` : clean;
    this.send(instance, "pty_write", { data });
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
