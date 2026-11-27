import type { ITheme } from "@xterm/xterm";
import type { ThemeId } from "../store/settingsStore";

/**
 * Paletas ANSI por tema. El slot `cyan` es obligatorio (los programas lo usan):
 * en los temas oscuros es un verdigris apagado, no un cian neón.
 */
const FOSFORO: ITheme = {
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

/** Monitor de fósforo P1: verde sobre grafito, con el resto de la paleta apagada. */
const FOSFORO_VERDE: ITheme = {
  ...FOSFORO,
  background: "#0d0f0d",
  foreground: "#d8f0dc",
  cursor: "#6fe39a",
  cursorAccent: "#0d0f0d",
  selectionBackground: "rgba(111, 227, 154, 0.22)",
  black: "#1a1e1a",
  green: "#6fe39a",
  brightGreen: "#9ff2bc",
  brightBlack: "#6f7d6c",
};

/** Claro y cálido: tinta sobre papel. Todos los colores con contraste ≥ 4.5:1. */
const PAPEL: ITheme = {
  background: "#f6f3ec",
  foreground: "#1d1a15",
  cursor: "#8c4b00",
  cursorAccent: "#f6f3ec",
  selectionBackground: "rgba(140, 75, 0, 0.18)",
  selectionInactiveBackground: "rgba(29, 26, 21, 0.08)",
  black: "#1d1a15",
  red: "#ad2e17",
  green: "#42661a",
  yellow: "#7d5a00",
  blue: "#2e5a8c",
  magenta: "#8a3a74",
  cyan: "#2d6b5c",
  white: "#d8d1c3",
  brightBlack: "#675f52",
  brightRed: "#c23a20",
  brightGreen: "#527d22",
  brightYellow: "#946c00",
  brightBlue: "#3a6ea6",
  brightMagenta: "#a3488a",
  brightCyan: "#357d6b",
  brightWhite: "#fbf9f4",
};

/**
 * Neón: el verde del logo como acento (cursor, selección, verde ANSI). El
 * fondo es opaco; con glass, el TerminalManager lo vuelve transparente y el
 * velo lo pone el panel (CSS), así la terminal se ve sobre el escritorio
 * difuminado sin perder contraste.
 */
const NEON: ITheme = {
  background: "#0a0d0c",
  foreground: "#e6f1ea",
  cursor: "#00e356",
  cursorAccent: "#0a0d0c",
  selectionBackground: "rgba(0, 227, 86, 0.24)",
  selectionInactiveBackground: "rgba(230, 241, 234, 0.08)",
  black: "#18201c",
  red: "#ff6b5b",
  green: "#00e356",
  yellow: "#f2c14e",
  blue: "#7aa7e0",
  magenta: "#c58fd0",
  cyan: "#5fd4c0",
  white: "#d5e2da",
  brightBlack: "#71857a",
  brightRed: "#ff9286",
  brightGreen: "#6dff9e",
  brightYellow: "#ffd97a",
  brightBlue: "#a3c3ec",
  brightMagenta: "#ddb2e6",
  brightCyan: "#8ce8d8",
  brightWhite: "#f5fbf7",
};

/**
 * Navidad: noche de pino con tinta de nieve. El rojo de caramelo es el
 * cursor; el dorado, la selección (como la estrella del árbol).
 */
const NAVIDAD: ITheme = {
  background: "#0b1512",
  foreground: "#eef4f0",
  cursor: "#ff4d6d",
  cursorAccent: "#0b1512",
  selectionBackground: "rgba(255, 209, 102, 0.24)",
  selectionInactiveBackground: "rgba(238, 244, 240, 0.08)",
  black: "#16241f",
  red: "#ff5c6c",
  green: "#4fd182",
  yellow: "#ffd166",
  blue: "#7fb2ff",
  magenta: "#e08ad6",
  cyan: "#6fd6c8",
  white: "#dfe9e3",
  brightBlack: "#7a958a",
  brightRed: "#ff8a96",
  brightGreen: "#86e8a8",
  brightYellow: "#ffe09a",
  brightBlue: "#a8cbff",
  brightMagenta: "#f0b3e8",
  brightCyan: "#9ee8de",
  brightWhite: "#ffffff",
};

/**
 * Vidrio líquido: el fondo real es transparente (lo pone el TerminalManager);
 * detrás está el vidrio ahumado del panel sobre tu imagen. Colores claros y
 * saturados para que se lean sobre cualquier fondo.
 */
const VIDRIO: ITheme = {
  background: "#0e1018",
  foreground: "#f2f5fb",
  cursor: "#7cc4ff",
  cursorAccent: "#0e1018",
  selectionBackground: "rgba(124, 196, 255, 0.28)",
  selectionInactiveBackground: "rgba(242, 245, 251, 0.1)",
  black: "#1c2030",
  red: "#ff6b7a",
  green: "#6ee7a0",
  yellow: "#ffd479",
  blue: "#7cb7ff",
  magenta: "#d49bff",
  cyan: "#6fe0e6",
  white: "#dde3ee",
  brightBlack: "#959eb3",
  brightRed: "#ff98a3",
  brightGreen: "#9ff2c2",
  brightYellow: "#ffe4a6",
  brightBlue: "#a9d0ff",
  brightMagenta: "#e5c1ff",
  brightCyan: "#a2eef1",
  brightWhite: "#ffffff",
};

export const XTERM_THEMES: Record<ThemeId, ITheme> = {
  neon: NEON,
  fosforo: FOSFORO,
  "fosforo-verde": FOSFORO_VERDE,
  papel: PAPEL,
  navidad: NAVIDAD,
  vidrio: VIDRIO,
};

/** Temas cuya terminal es transparente siempre: el velo y lo de atrás los pone la app. */
export const SEE_THROUGH_THEMES: ReadonlySet<ThemeId> = new Set(["vidrio"]);
