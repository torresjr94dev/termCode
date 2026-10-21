/** Saltos de línea como Enter de terminal (`\r`) y fuera todo carácter de control salvo el tabulador. */
export function sanitizePaste(text: string): string {
  // eslint-disable-next-line no-control-regex -- quitar controles es justo el objetivo
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\n/g, "\r");
}
