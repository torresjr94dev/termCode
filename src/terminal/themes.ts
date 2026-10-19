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

export const XTERM_THEMES: Record<ThemeId, ITheme> = {
  fosforo: FOSFORO,
  "fosforo-verde": FOSFORO_VERDE,
  papel: PAPEL,
};
