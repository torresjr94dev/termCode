/**
 * OSC 7501, Program Status Protocol (borrador 0.4): el programa de un panel
 * dice qué está haciendo (trabajando, bloqueado esperándote, listo…). Claude
 * Code ≥ 2.1.295 lo usa si la terminal contesta a `OSC 7501 ; ?` al arrancar.
 *
 * A diferencia de los hooks (archivos que se leen por sondeo y se atan al
 * panel por una variable de entorno), esto llega por el PTY del propio panel:
 * no puede caer en el panel equivocado y vale también para un `claude`
 * escrito a mano en una shell. Todo lo que llega es del programa del panel:
 * se valida como entrada no confiable y nunca se devuelve nada salvo `?`.
 */

export type ProgramState = "idle" | "working" | "done" | "blocked" | "error" | "clear";
export type BlockedKind = "permission" | "question" | "auth";

export interface ProgramStatus {
  state: ProgramState;
  /** Ruta jerárquica (`build/test`); null es el registro raíz del programa. */
  id: string | null;
  kind: BlockedKind | null;
  /** 0–100; null = indeterminado. */
  progress: number | null;
  /** Identificador estable del programa (`claude-code`, `terraform`…). */
  app: string | null;
  title: string | null;
  msg: string | null;
}

/** La respuesta a la consulta: soporta el protocolo con los estados y tipos por defecto. */
export const PROGRAM_STATUS_REPLY = "\x1b]7501;?\x1b\\";

const STATES = new Set<ProgramState>(["idle", "working", "done", "blocked", "error", "clear"]);
const KINDS = new Set<BlockedKind>(["permission", "question", "auth"]);
const KEY = /^[a-z]{1,16}$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
/** C0, DEL y C1: un mensaje con controles se descarta entero. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Marcas bidi y caracteres de formato invisibles: se quitan antes de mostrar. */
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

const LIMITS = { sequence: 4096, msg: [2732, 2048], title: [256, 192], id: 128, depth: 8 } as const;

/** Base64 estándar de UTF-8 (relleno opcional). `undefined` si no es válido. */
function decodeText(value: string, [maxEncoded, maxDecoded]: readonly [number, number]): string | undefined {
  if (value.length > maxEncoded || /[^A-Za-z0-9+/=]/.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (bytes.length > maxDecoded) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (CONTROL.test(text)) return undefined;
    return text.replace(INVISIBLE, "").trim();
  } catch {
    return undefined;
  }
}

function validId(id: string): boolean {
  if (id.length > LIMITS.id) return false;
  const segments = id.split("/");
  return segments.length <= LIMITS.depth && segments.every((s) => SEGMENT.test(s));
}

/**
 * El cuerpo de un `OSC 7501 ; … ST`: `"query"` para la consulta de soporte,
 * el informe si es válido, o null si hay que ignorarlo (estado desconocido,
 * id mal formado, base64 inválido, controles o límites excedidos).
 */
export function parseProgramStatus(data: string): ProgramStatus | "query" | null {
  if (data.length > LIMITS.sequence) return null;
  if (data.trimStart().startsWith("?")) return "query";

  const pairs = new Map<string, string>();
  for (const pair of data.split(":")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // Un par mal formado se salta; el resto del informe vale.
    if (!KEY.test(key) || !VALUE.test(value)) continue;
    pairs.set(key, value);
  }

  const state = pairs.get("state") as ProgramState | undefined;
  if (!state || !STATES.has(state)) return null;

  const rawId = pairs.get("id");
  if (rawId !== undefined && !validId(rawId)) return null;

  let msg: string | null = null;
  let title: string | null = null;
  const rawMsg = pairs.get("msg");
  if (rawMsg) {
    const text = decodeText(rawMsg, LIMITS.msg);
    if (text === undefined) return null;
    msg = text || null;
  }
  const rawTitle = pairs.get("title");
  if (rawTitle) {
    const text = decodeText(rawTitle, LIMITS.title);
    if (text === undefined) return null;
    title = text || null;
  }

  const kind = pairs.get("kind") as BlockedKind | undefined;
  const app = pairs.get("app");
  const rawProgress = pairs.get("progress");
  const progress = rawProgress !== undefined && /^\d{1,3}$/.test(rawProgress) ? Number(rawProgress) : NaN;

  return {
    state,
    id: rawId ?? null,
    kind: state === "blocked" && kind && KINDS.has(kind) ? kind : null,
    progress: (state === "working" || state === "blocked") && progress >= 0 && progress <= 100 ? progress : null,
    app: app && APP.test(app) ? app : null,
    title,
    msg,
  };
}
