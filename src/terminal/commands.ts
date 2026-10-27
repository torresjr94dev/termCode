import type { IMarker, Terminal } from "@xterm/xterm";
import type { AgentKind, ProcessInfo } from "../types/layout";

/**
 * Comandos de un panel, a partir de las marcas de la integración con la shell
 * (OSC 133 A/C/D, 633 E y 7). Sin integración no hay registros y todo lo que
 * depende de esto simplemente no aparece.
 */
export interface CommandRecord {
  id: number;
  command: string;
  cwd: string | null;
  /** Línea donde empezó el prompt (para saltar entre comandos). */
  prompt: IMarker | null;
  /** Primera línea de salida. */
  start: IMarker;
  /** Línea siguiente a la última salida (al terminar). */
  end: IMarker | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

const MAX_RECORDS = 400;
let nextId = 1;

/** `633;E` escapa `\` como `\\` y bytes como `\xNN` (p. ej. `;` = `\x3b`). */
export function decodeCommandLine(raw: string): string {
  return raw.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, escaped: string, hex?: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : escaped,
  );
}

/**
 * Lo que no abre la interfaz del agente: modos sin TUI y subcomandos. Mismo
 * criterio que la función `claude` de la integración con zsh. En Codex `-p`
 * es `--profile` (interactivo), así que cada uno tiene su lista.
 */
const NOT_INTERACTIVE: Record<AgentKind, { flags: Set<string>; subcommands: Set<string> }> = {
  claude: {
    flags: new Set(["-p", "--print", "-v", "--version", "-h", "--help"]),
    subcommands: new Set(["mcp", "config", "doctor", "update", "install", "setup-token", "migrate-installer", "plugin", "plugins"]),
  },
  codex: {
    flags: new Set(["-V", "--version", "-h", "--help"]),
    subcommands: new Set(["exec", "e", "login", "logout", "mcp", "mcp-server", "app-server", "completion", "apply", "a", "sandbox", "debug"]),
  },
};
/** Lo que puede ir antes del programa sin cambiar cuál es: `FOO=1`, `command`, `exec`… */
const PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|command|builtin|exec|noglob|nocorrect)$/;

/**
 * El agente que abre un comando escrito en la shell (`claude`,
 * `/opt/bin/codex --model o3`, `ANTHROPIC_MODEL=x claude`), o null si no es
 * uno o no abre su interfaz (`claude -p …`, `codex exec …`, `claude mcp list`).
 */
export function commandAgent(command: string | null | undefined): AgentKind | null {
  const words = command?.trim().split(/\s+/) ?? [];
  const at = words.findIndex((w) => !PREFIX.test(w));
  const program = at >= 0 ? words[at].slice(words[at].lastIndexOf("/") + 1) : "";
  if (program !== "claude" && program !== "codex") return null;
  const args = words.slice(at + 1);
  const rules = NOT_INTERACTIVE[program];
  // El subcomando es la primera palabra que no es opción (un alias puede meter opciones antes).
  const first = args.find((a) => !a.startsWith("-")) ?? "";
  if (args.some((a) => rules.flags.has(a)) || rules.subcommands.has(first)) return null;
  return program;
}

/** `file://host/Users/x/Mi%20dir` → `/Users/x/Mi dir`; `file://host/C:/Users/x` → `C:\Users\x`. */
export function decodeCwd(raw: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(raw);
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    path = match[1];
  }
  return /^\/[A-Za-z]:(\/|$)/.test(path) ? `${path.slice(1, 3)}\\${path.slice(4).replace(/\//g, "\\")}` : path;
}

/**
 * Completa lo que el sistema no sabe con lo que reportó la shell. En Windows
 * no se puede leer la carpeta ni el proceso en primer plano de otro proceso
 * (`foregroundPid` llega vacío), pero la integración sí los cuenta (OSC 7 y
 * 133). Un agente se lanza sin prompt previo: sigue ocupado hasta que aparece
 * el primero, que es cuando el agente terminó.
 */
export function withShellFacts(
  info: ProcessInfo,
  tracker: Pick<CommandTracker, "cwd" | "records" | "integrated">,
  isShell: boolean,
): ProcessInfo {
  const cwd = info.cwd ?? tracker.cwd;
  if (info.foregroundPid !== null) return { ...info, cwd };
  const last = tracker.records.at(-1);
  const command = last && last.endedAt === null ? last.command.split(/\s+/)[0] || "un comando" : null;
  const agentRunning = !isShell && !tracker.integrated;
  return {
    ...info,
    cwd,
    busy: info.busy || command !== null || agentRunning,
    foregroundName: command ?? info.foregroundName,
  };
}

export class CommandTracker {
  records: CommandRecord[] = [];
  cwd: string | null = null;
  /** Hay integración activa en este panel (se vio al menos un prompt). */
  integrated = false;
  private pendingCommand = "";
  private lastPrompt: IMarker | null = null;
  private listeners = new Set<() => void>();
  version = 0;

  constructor(
    private readonly term: Terminal,
    private readonly onFinished: (record: CommandRecord) => void,
    private readonly onCwd: (cwd: string) => void,
    /** La shell volvió a su prompt: lo que corría en el panel ya terminó. */
    private readonly onPrompt: () => void = () => {},
    /** Empezó a correr un comando (lo que escribiste, tal cual). */
    private readonly onStart: (command: string) => void = () => {},
  ) {}

  /** Conecta los manejadores OSC. Devuelve cómo desconectarlos. */
  attach(): () => void {
    const parser = this.term.parser;
    const subs = [
      parser.registerOscHandler(133, (data) => this.on133(data)),
      parser.registerOscHandler(633, (data) => {
        if (!data.startsWith("E;")) return false;
        this.pendingCommand = decodeCommandLine(data.slice(2)).trim();
        return true;
      }),
      parser.registerOscHandler(7, (data) => {
        const cwd = decodeCwd(data);
        if (cwd && cwd !== this.cwd) {
          this.cwd = cwd;
          this.onCwd(cwd);
          this.changed();
        }
        return true;
      }),
    ];
    return () => subs.forEach((s) => s.dispose());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  private on133(data: string): boolean {
    const [kind, arg] = data.split(";");
    switch (kind) {
      case "A": {
        const first = !this.integrated;
        this.integrated = true;
        this.lastPrompt?.dispose();
        this.lastPrompt = this.term.registerMarker(0);
        // El primer prompt: la shell terminó de arrancar (quien espera ese momento se entera).
        if (first) this.changed();
        this.onPrompt();
        return true;
      }
      case "C": {
        const start = this.term.registerMarker(0);
        if (!start) return true;
        this.records.push({
          id: nextId++,
          command: this.pendingCommand,
          cwd: this.cwd,
          prompt: this.lastPrompt,
          start,
          end: null,
          startedAt: Date.now(),
          endedAt: null,
          exitCode: null,
        });
        const command = this.pendingCommand;
        this.lastPrompt = null;
        this.pendingCommand = "";
        this.trim();
        this.changed();
        this.onStart(command);
        return true;
      }
      case "D": {
        const record = this.running();
        if (record) {
          record.end = this.term.registerMarker(0) ?? null;
          record.endedAt = Date.now();
          const code = Number(arg);
          record.exitCode = Number.isFinite(code) ? code : null;
          this.changed();
          this.onFinished(record);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private trim() {
    while (this.records.length > MAX_RECORDS) {
      const old = this.records.shift();
      old?.prompt?.dispose();
      old?.start.dispose();
      old?.end?.dispose();
    }
  }

  running(): CommandRecord | undefined {
    const last = this.records[this.records.length - 1];
    return last && last.endedAt === null ? last : undefined;
  }

  last(): CommandRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /** Texto de la salida de un comando (sin las líneas vacías del final). */
  output(record: CommandRecord, maxChars = 200_000): string {
    const buffer = this.term.buffer.active;
    const from = record.start.line;
    const to = record.end ? record.end.line : buffer.baseY + buffer.cursorY;
    if (from < 0) return "";
    const lines: string[] = [];
    let size = 0;
    for (let y = from; y < to && size < maxChars; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      const text = line.translateToString(true);
      // Las líneas envueltas continúan la anterior.
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
      size += text.length;
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  }

  /** Comando anterior/siguiente respecto a la línea `fromLine` (para ⌘↑ / ⌘↓). */
  neighbour(fromLine: number, direction: -1 | 1): CommandRecord | undefined {
    const anchor = (r: CommandRecord) => (r.prompt && !r.prompt.isDisposed ? r.prompt.line : r.start.line);
    const valid = this.records.filter((r) => !r.start.isDisposed && anchor(r) >= 0);
    if (direction < 0) return [...valid].reverse().find((r) => anchor(r) < fromLine);
    return valid.find((r) => anchor(r) > fromLine);
  }

  anchorLine(record: CommandRecord): number {
    return record.prompt && !record.prompt.isDisposed ? record.prompt.line : record.start.line;
  }

  dispose() {
    this.records.forEach((r) => {
      r.prompt?.dispose();
      r.start.dispose();
      r.end?.dispose();
    });
    this.records = [];
    this.lastPrompt?.dispose();
    this.listeners.clear();
  }
}
