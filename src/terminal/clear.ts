/** `CSI 3 J`: "borra el historial". Lo emite `clear` (no Ctrl+L, que solo limpia la vista). */
const CLEAR_SCROLLBACK = [0x1b, 0x5b, 0x33, 0x4a];

/**
 * Posición justo después del último `ESC[3J` del bloque, o -1. Ahí se
 * vuelve a poner la tarjeta de bienvenida: después del borrado y antes de que
 * la shell dibuje el prompt.
 */
export function indexAfterClear(bytes: Uint8Array): number {
  const n = CLEAR_SCROLLBACK.length;
  for (let i = bytes.length - n; i >= 0; i--) {
    let match = true;
    for (let k = 0; k < n; k++) {
      if (bytes[i + k] !== CLEAR_SCROLLBACK[k]) {
        match = false;
        break;
      }
    }
    if (match) return i + n;
  }
  return -1;
}
