import { Terminal, type IWindowsPty } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { ImageAddon } from "@xterm/addon-image";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { ProgressAddon, type IProgressState } from "@xterm/addon-progress";
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_TAURI } from "../lib/ipc";
import { IS_MAC, IS_WINDOWS } from "../lib/shortcuts";
import { DEFAULT_SETTINGS, type Settings } from "../store/settingsStore";
import type { AgentStatus, PaneShell, ProcessInfo } from "../types/layout";
import { CommandTracker, commandAgent, withShellFacts, type CommandRecord } from "./commands";
import { fileLinkProvider, type FileLinkTarget } from "./links";
import { sanitizePaste } from "./paste";
import { clearEnd, initialClearState, type ClearState } from "./clear";
import { XTERM_THEMES } from "./themes";
import { parseProgramStatus, PROGRAM_STATUS_REPLY, type ProgramStatus } from "./programStatus";

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
  /** Otra shell que la del sistema (la elegida al abrir la pestaña). */
  shell?: PaneShell;
}

interface TerminalInstance {
  id: string;
  backendSessionId: number | null;
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  serializeAddon: SerializeAddon;
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
  /**
   * Escrituras al PTY, una tras otra: dos `invoke` seguidos pueden ejecutarse
   * en paralelo en el backend y cruzarse (p. ej. la respuesta a OSC 7501 y la
   * de `CSI c` que el programa manda justo detrás para saber si contestamos).
   */
  inputChain: Promise<void>;
  /** Lo último que dijo el programa del panel por OSC 7501 (registro raíz). */
  program: ProgramStatus | null;
  /** Shell (no agente lanzado por termCode). */
  isShell: boolean;
  /** Dónde termina el borrado de un `clear` (se sigue en los bytes, en orden). */
  clear: ClearState;
  /** Llegó salida desde la última vez que se guardó su contenido (para no serializarlo de balde). */
  dirty: boolean;
  /** Cuándo arrancó su PTY (para medir cuánto tarda la shell en dar su primer prompt). */
  spawnedAt: number | null;
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
  /** El programa del panel reportó su estado (OSC 7501). */
  onProgramStatus: (paneId: string, status: ProgramStatus) => void;
  /** La shell volvió a su prompt: lo que corría (un agente, un comando) ya no está. */
  onPrompt: (paneId: string) => void;
  /** Empezó un comando escrito en la shell (integración): puede ser un agente. */
  onCommandStart: (paneId: string, command: string) => void;
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

/** Programas de OSC 7501 cuyo prompt es multilínea con Ctrl+J. */
const MULTILINE_APPS = new Set(["claude-code", "codex"]);

/**
 * Lo que un programa de pantalla completa deja encendido si muere sin
 * apagarlo (un ssh que se corta con Claude Code o vim del otro lado): con el
 * ratón activo, cada movimiento llega a la shell como `35;88;22M35;87;22M…`.
 * En el prompt nadie lo pidió, así que se apaga (y el cursor vuelve a verse).
 */
const ABANDONED_MODES = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?25h";

function resetAbandonedModes(term: Terminal) {
  if (term.modes.mouseTrackingMode === "none" && !term.modes.sendFocusMode) return;
  term.write(ABANDONED_MODES);
}

/** Shift+Enter sin más modificadores (y sin IME a medio componer). */
function isShiftEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;
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
  /** Lo que cada panel restaurado tenía en pantalla: se escribe antes de su shell. */
  private restoreQueue = new Map<string, { text: string; at: number }>();
  private sizeListeners = new Set<() => void>();
  private progressListeners = new Set<() => void>();
  private settings: Settings = DEFAULT_SETTINGS;
  /** La última terminal que tuvo el teclado: al remontarse (mover, dividir, restaurar) lo recupera solo ella. */
  private focusedId: string | null = null;
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
      // Ctrl+L (ESC[2J) limpia la vista, no el historial: lo que había en pantalla sube
      // al scrollback, como en Terminal.app e iTerm2 (sin esto, una pantalla de salida
      // desaparecía). `clear` sigue borrando todo con ESC[3J. ConPTY repinta con ESC[2J
      // al redimensionar: en Windows duplicaría pantallas en el historial.
      scrollOnEraseInDisplay: !IS_WINDOWS,
      ...(this.windowsPty ? { windowsPty: this.windowsPty } : {}),
      ...terminalOptions(this.settings),
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 2000 });
    const progressAddon = new ProgressAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
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
      serializeAddon,
      tracker: new CommandTracker(
        term,
        (record) => this.hooks?.onCommandFinished(id, record),
        (cwd) => this.hooks?.onCwd(id, cwd),
        () => {
          // Volvió el prompt: lo que corría ya no está, aunque haya salido sin limpiar
          // (su estado por OSC 7501, el ratón o el foco que dejó encendidos).
          instance.program = null;
          resetAbandonedModes(term);
          this.hooks?.onPrompt(id);
        },
        (command) => this.hooks?.onCommandStart(id, command),
      ),
      progress: { state: 0, value: 0 },
      container: null,
      spawnRequested: false,
      pendingAck: 0,
      ackScheduled: false,
      pendingInput: [],
      inputChain: Promise.resolve(),
      program: null,
      isShell: false,
      clear: initialClearState(),
      dirty: false,
      spawnedAt: null,
      dispose: [],
    };
    instance.dispose.push(instance.tracker.attach());
    term.attachCustomKeyEventHandler((e) => this.handleKey(instance, e));

    const progressSub = progressAddon.onChange((state) => {
      instance.progress = state;
      this.progressListeners.forEach((l) => l());
    });
    instance.dispose.push(() => progressSub.dispose());

    // Broadcast solo desde el panel con el teclado: `onData` también trae las
    // respuestas automáticas de xterm (`CSI c`, posición del cursor, foco), y
    // las de un panel de fondo no deben escribirse en todos los demás.
    const broadcasting = () => Boolean(this.hooks?.isBroadcastEnabled()) && this.hasFocus(instance);
    term.onData((data) => {
      if (broadcasting()) this.broadcast("pty_write", { data });
      else this.send(instance, "pty_write", { data });
    });
    // Bytes no UTF-8 (reportes de ratón antiguos): van tal cual, no como texto.
    term.onBinary((data) => {
      const bytes = Array.from(data, (c) => c.charCodeAt(0) & 0xff);
      if (broadcasting()) this.broadcast("pty_write_bytes", { data: bytes });
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
    // OSC 7501: el programa dice qué hace. A la consulta se contesta siempre
    // (es lo único que devolvemos); los informes van al estado del panel.
    term.parser.registerOscHandler(7501, (data) => {
      const report = parseProgramStatus(data);
      if (report === "query") {
        this.send(instance, "pty_write", { data: PROGRAM_STATUS_REPLY });
      } else if (report && report.id === null) {
        // Solo el registro raíz: los hijos (subagentes, tareas) los resume el propio programa.
        instance.program = report.state === "clear" ? null : report;
        this.hooks?.onProgramStatus(id, report);
      }
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
    const opening = !instance.term.element;
    if (instance.term.element) {
      // Al dividir o mover un panel, React lo remonta en un contenedor nuevo. `open()`
      // no re-ancla un terminal ya abierto: hay que mover su elemento a mano.
      container.replaceChildren(instance.term.element);
    } else {
      container.replaceChildren();
      instance.term.open(container);
      this.enableWebgl(id);
      // Imágenes en línea (sixel e iTerm2): con límites de memoria razonables.
      instance.term.loadAddon(new ImageAddon({ pixelLimit: 16_777_216, storageLimit: 64, sixelSupport: true, iipSupport: true }));
      const textarea = instance.term.textarea;
      if (textarea) {
        const onFocus = () => {
          this.focusedId = id;
        };
        textarea.addEventListener("focus", onFocus);
        instance.dispose.push(() => textarea.removeEventListener("focus", onFocus));
      }
    }

    // Moverlo de sitio le quita el foco: lo recupera si lo tenía, sin robárselo a otro.
    requestAnimationFrame(() => {
      this.fit(id);
      if (opening || this.focusedId === id) instance.term.focus();
    });

    if (!instance.spawnRequested) {
      instance.spawnRequested = true;
      instance.isShell = !spec.command;
      const restored = this.restoreQueue.get(id);
      this.restoreQueue.delete(id);
      if (restored) void this.restoreThenSpawn(instance, spec, restored);
      else void this.spawn(instance, spec);
    }
  }

  /**
   * Lo que el panel tenía en pantalla en la sesión anterior, y una línea
   * tenue que lo separa de la shell nueva. Nunca pasa por el PTY: la shell y
   * los agentes que leen paneles no lo ven como salida suya.
   */
  private async restoreThenSpawn(instance: TerminalInstance, spec: SpawnSpec, restored: { text: string; at: number }) {
    const when = new Date(restored.at).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    await new Promise<void>((resolve) => instance.term.write(restored.text, resolve));
    instance.term.write(`\x1b[0m\r\n\x1b[2m── sesión anterior · ${when} ──\x1b[0m\r\n`);
    if (this.instances.get(instance.id) !== instance) return;
    await this.spawn(instance, spec);
  }

  /** Paneles que al abrirse deben volver con su contenido anterior (los de la sesión restaurada). */
  public setRestore(entries: Record<string, { text: string; at: number }>) {
    this.restoreQueue = new Map(Object.entries(entries));
  }

  /** Paneles con salida nueva desde la última vez que se preguntó (y se dan por vistos). */
  public takeDirty(ids: string[]): string[] {
    const dirty: string[] = [];
    for (const id of ids) {
      const instance = this.instances.get(id);
      if (!instance?.dirty) continue;
      instance.dirty = false;
      dirty.push(id);
    }
    return dirty;
  }

  /**
   * Lo que hay en pantalla de un panel, con colores, para restaurarlo al
   * reabrir: las últimas `lines` líneas del búfer normal (no el de vim o
   * Codex). Las líneas en blanco de arriba (la bienvenida) no se guardan.
   */
  public serialize(id: string, lines: number): string | null {
    const instance = this.instances.get(id);
    if (!instance?.term.element) return null;
    try {
      const text = instance.serializeAddon
        .serialize({ scrollback: lines, excludeModes: true, excludeAltBuffer: true })
        .replace(/^(?:\s*\r?\n)+/, "")
        .trimEnd();
      return text || null;
    } catch (err) {
      console.warn("[termCode] serialize:", err);
      return null;
    }
  }

  /**
   * Salida de la shell hacia xterm. Tras un `clear` que escribiste va un
   * `ESC[3J` de más: borra la pantalla que `ESC[2J` subió al historial (macOS
   * manda `ESC[3J` primero). Así `clear` deja el historial vacío y Ctrl+L lo
   * conserva.
   */
  private receive(instance: TerminalInstance, bytes: Uint8Array) {
    const { term } = instance;
    instance.dirty = true;
    const ack = (n: number) => () => this.queueAck(instance, n);
    const cut = instance.isShell && term.buffer.active.type === "normal" ? clearEnd(bytes, instance.clear) : -1;
    if (cut < 0) {
      term.write(bytes, ack(bytes.byteLength));
      return;
    }
    term.write(bytes.subarray(0, cut), ack(cut));
    term.write("\x1b[3J");
    term.write(bytes.subarray(cut), ack(bytes.byteLength - cut));
  }

  /** Para pruebas sin backend: salida como si viniera de la shell del panel. */
  public receiveForTesting(id: string, text: string) {
    const instance = this.instances.get(id);
    if (instance) this.receive(instance, new TextEncoder().encode(text));
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
          program: spec.command ? null : (spec.shell?.path ?? null),
          command: spec.command ?? null,
          args: spec.command ? [] : (spec.shell?.args ?? []),
          cwd: spec.cwd ?? null,
          env: [["TERMCODE_PANE_ID", instance.id]],
          cols: Math.max(term.cols || 80, 20),
          rows: Math.max(term.rows || 24, 5),
        },
        onData: channel,
        shellIntegration: this.settings.shellIntegration,
        // Un `claude` escrito a mano recibe el MCP de lectura igual que uno lanzado desde aquí.
        agentsReadPanes: this.settings.agentsReadPanes,
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
      instance.spawnedAt = Date.now();
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
    const id = instance.backendSessionId;
    const call = () => invoke(command, { id, ...args }).then(
      () => {},
      (err) => console.warn(`[termCode] ${command}:`, err),
    );
    if (INPUT_COMMANDS.has(command)) instance.inputChain = instance.inputChain.then(call);
    else void call();
  }

  /** El teclado está en este terminal (no en otro panel ni en un diálogo). */
  private hasFocus(instance: TerminalInstance): boolean {
    const element = instance.term.element;
    return Boolean(element && document.activeElement && element.contains(document.activeElement));
  }

  /**
   * Hay un agente en primer plano: el panel se abrió como agente, el programa
   * se anunció como tal por OSC 7501, o la shell dice que corre `claude`/`codex`.
   */
  private agentInForeground(instance: TerminalInstance): boolean {
    if (!instance.isShell) return true;
    if (instance.program?.app && MULTILINE_APPS.has(instance.program.app)) return true;
    return commandAgent(instance.tracker.running()?.command) !== null;
  }

  /**
   * Teclas antes de xterm. Shift+Enter en un agente es un salto de línea:
   * xterm manda el mismo `\r` que Enter (no habla el protocolo de teclado de
   * kitty), así que se envía Ctrl+J, que Claude Code y Codex leen como salto
   * de línea en cualquier terminal. En una shell, Shift+Enter sigue siendo
   * Enter (nano, por ejemplo, usa Ctrl+J para justificar).
   */
  private handleKey(instance: TerminalInstance, e: KeyboardEvent): boolean {
    if (isShiftEnter(e) && this.agentInForeground(instance)) {
      e.preventDefault();
      if (e.type === "keydown") instance.term.input("\n");
      return false;
    }
    return handleClipboardKey(instance.term, e);
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
    const instance = this.instances.get(id);
    if (!instance) return;
    this.focusedId = id;
    instance.term.focus();
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

  /** Modelo y contexto del Codex que corre en el panel (lo lee del rollout que tiene abierto). */
  public async codexStatus(id: string): Promise<AgentStatus | null> {
    const sessionId = this.instances.get(id)?.backendSessionId;
    if (sessionId === null || sessionId === undefined) return null;
    try {
      return await invoke<AgentStatus | null>("codex_status", { id: sessionId, paneId: id });
    } catch {
      return null;
    }
  }

  /**
   * Arranque de la shell: desde cuándo corre y si ya dio su primer prompt
   * (con la integración). null si no es una shell o aún no tiene PTY.
   */
  public startup(id: string): { spawnedAt: number; ready: boolean } | null {
    const instance = this.instances.get(id);
    if (!instance?.isShell || instance.spawnedAt === null) return null;
    return { spawnedAt: instance.spawnedAt, ready: instance.tracker.integrated };
  }

  /** Lo que corre bajo la shell del panel (sin la shell). */
  public async children(id: string): Promise<Array<{ pid: number; name: string; command: string }>> {
    const session = this.instances.get(id)?.backendSessionId;
    if (session === null || session === undefined) return [];
    try {
      return await invoke("pty_children", { id: session });
    } catch {
      return [];
    }
  }

  /** Puertos TCP en escucha de cada panel (de todo lo que corre bajo su shell). */
  public async ports(ids: string[]): Promise<Record<string, number[]>> {
    const bySession = new Map<number, string>();
    for (const id of ids) {
      const session = this.instances.get(id)?.backendSessionId;
      if (session !== null && session !== undefined) bySession.set(session, id);
    }
    if (!bySession.size) return {};
    try {
      const found = await invoke<Array<{ id: number; ports: number[] }>>("pty_ports", { ids: [...bySession.keys()] });
      const out: Record<string, number[]> = {};
      for (const { id, ports } of found) {
        const pane = bySession.get(id);
        if (pane && ports.length) out[pane] = ports;
      }
      return out;
    } catch {
      return {};
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

  /**
   * Como `run`, pero espera a que la shell esté lista (su primer prompt, con
   * la integración; si no la hay, un momento): lo escrito antes de que cargue
   * tu .zshrc podría perderse.
   */
  public runWhenReady(id: string, line: string, timeoutMs = 6000) {
    const started = Date.now();
    const tick = () => {
      const instance = this.instances.get(id);
      const waited = Date.now() - started;
      if (instance && instance.backendSessionId !== null && (instance.tracker.integrated || waited > 2500)) {
        this.run(id, line);
        return;
      }
      if (waited < timeoutMs) setTimeout(tick, 100);
    };
    tick();
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
