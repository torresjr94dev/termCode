import { decodeCommandLine } from "./commands";

/**
 * Lo que hay que saber del flujo de bytes de una shell para reconocer un
 * `clear`, en el orden en que llegan (no en el que xterm los procesa, que es
 * después).
 */
export interface ClearState {
  /** Comando en curso según `OSC 633;E` (null en el prompt). */
  command: string | null;
  /** Ya llegó el `ESC[3J` de un `clear` y falta su `ESC[2J`. */
  pendingErase: boolean;
  /** Ya llegó el `ESC[2J` de un `clear` (Linux lo manda antes que `ESC[3J`). */
  erased: boolean;
  /** `command` es un `clear` (se calcula una vez por comando, no por bloque). */
  clearing: boolean;
}

export const initialClearState = (): ClearState => ({ command: null, pendingErase: false, erased: false, clearing: false });

/** `clear`, `reset`, `tput clear`… (también con ruta o `command` delante): lo que tú escribes para limpiar. */
export function isClearCommand(command: string): boolean {
  return /^(?:(?:command|builtin|noglob)\s+)*(?:\S*\/)?(?:clear|reset|cls|tput\s+(?:clear|reset))(?:\s|;|$)/.test(command.trim());
}

const ESC = 0x1b;
const BEL = 0x07;
const OSC_633_E = [0x36, 0x33, 0x33, 0x3b, 0x45, 0x3b]; // "633;E;" (tras "ESC ]")
const OSC_133 = [0x31, 0x33, 0x33, 0x3b]; // "133;"

function startsWith(bytes: Uint8Array, at: number, prefix: readonly number[]): boolean {
  if (at + prefix.length > bytes.length) return false;
  for (let k = 0; k < prefix.length; k++) if (bytes[at + k] !== prefix[k]) return false;
  return true;
}

/** Fin de un OSC (BEL o `ESC \`) desde `from`, o null si el bloque se corta antes. */
function oscEnd(bytes: Uint8Array, from: number): { body: number; next: number } | null {
  for (let i = from; i < bytes.length; i++) {
    if (bytes[i] === BEL) return { body: i, next: i + 1 };
    if (bytes[i] === ESC && bytes[i + 1] === 0x5c) return { body: i, next: i + 2 };
  }
  return null;
}

const utf8 = new TextDecoder();

function setCommand(state: ClearState, command: string | null) {
  state.command = command;
  state.clearing = command !== null && isClearCommand(command);
  state.pendingErase = false;
  state.erased = false;
}

/**
 * Un OSC que empieza en `at` (el byte tras `ESC ]`): `633;E` dice qué comando
 * corre y `133;A`/`133;D` que ya no corre ninguno. Devuelve dónde seguir.
 */
function readOsc(bytes: Uint8Array, at: number, state: ClearState): number {
  if (startsWith(bytes, at, OSC_633_E)) {
    const end = oscEnd(bytes, at + OSC_633_E.length);
    if (!end) return bytes.length;
    setCommand(state, decodeCommandLine(utf8.decode(bytes.subarray(at + OSC_633_E.length, end.body))));
    return end.next;
  }
  if (startsWith(bytes, at, OSC_133)) {
    const kind = bytes[at + OSC_133.length];
    // A (prompt) o D (terminó): ya no hay comando corriendo.
    if (kind === 0x41 || kind === 0x44) setCommand(state, null);
  }
  return at;
}

/**
 * Dónde termina, en este bloque, la limpieza de un `clear` que escribiste
 * (después del borrado y antes del prompt), o -1 si no hay. macOS manda
 * `ESC[3J ESC[H ESC[2J` y Linux `ESC[H ESC[2J ESC[3J`: el punto es tras la
 * última de las dos, venga en el orden que venga.
 *
 * Solo cuenta un `clear` corriendo en la shell: Vite, `tsc -w`, jest o
 * nodemon también limpian la pantalla y lo que hayan dejado en el historial
 * es suyo.
 *
 * Corre con cada bloque de salida de cada shell, así que casi siempre solo
 * busca `ESC ]` (los OSC son escasos; los colores, `ESC [`, no importan) con
 * `indexOf` nativo y sin copiar nada. Solo mientras corre un `clear` mira
 * cada `ESC`.
 */
export function clearEnd(bytes: Uint8Array, state: ClearState): number {
  let cut = -1;
  let i = 0;
  while (i < bytes.length) {
    if (!state.clearing) {
      const bracket = bytes.indexOf(0x5d, i);
      if (bracket === -1) break;
      i = bracket > 0 && bytes[bracket - 1] === ESC ? Math.max(readOsc(bytes, bracket + 1, state), bracket + 1) : bracket + 1;
      continue;
    }
    const esc = bytes.indexOf(ESC, i);
    if (esc === -1 || esc === bytes.length - 1) break;
    const next = bytes[esc + 1];
    i = esc + 1;
    if (next === 0x5d) {
      i = Math.max(readOsc(bytes, esc + 2, state), esc + 2);
    } else if (next === 0x5b && (bytes[esc + 2] === 0x32 || bytes[esc + 2] === 0x33) && bytes[esc + 3] === 0x4a) {
      const end = esc + 4;
      i = end;
      if (bytes[esc + 2] === 0x33) {
        if (state.erased) {
          cut = end;
          state.erased = false;
        } else {
          state.pendingErase = true;
        }
      } else if (state.pendingErase) {
        cut = end;
        state.pendingErase = false;
      } else {
        state.erased = true;
      }
    }
  }
  return cut;
}
