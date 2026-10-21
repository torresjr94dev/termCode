import { shortcutLabel } from "../../lib/shortcuts";

/**
 * La bienvenida en texto: solo para el modo lector de pantalla (la tarjeta
 * visual se lee como ruido). Colores de la paleta ANSI: cada tema los pinta
 * con sus tonos, también el claro.
 */
export function welcomeLine(accent: "yellow" | "green"): string {
  const color = accent === "green" ? 32 : 33;
  return `\r\n  \x1b[1;39mt\x1b[0;${color}m»\x1b[1;39mc\x1b[0;${color}m_\x1b[0m termCode \x1b[90m· by CODERGENIUS MX · ${shortcutLabel("palette")} todos los comandos\x1b[0m\r\n\r\n`;
}
