/**
 * Arrastre de los divisores: entre paneles, del visor acoplado y de la
 * terminal acoplada.
 *
 * El ratio se mueve lo mismo que el cursor desde donde agarraste el divisor.
 * Antes salía de la posición absoluta del cursor, y el divisor saltaba hasta
 * dejar su borde bajo él (4 px si lo tomabas por el centro): el primer
 * movimiento, aunque fuera de 0 px, lo corría, y la segunda pulsación de un
 * doble clic («a la mitad») podía caer ya fuera de él.
 */

/** El ratio tras mover el cursor `moved` px; `span` son los px que se mueve el borde con un ratio de 1. */
export function draggedRatio(start: number, moved: number, span: number, sign: 1 | -1): number {
  return span > 0 && Number.isFinite(span) ? start + (sign * moved) / span : start;
}

export interface DividerDrag {
  axis: "x" | "y";
  /** El ratio al agarrar el divisor. */
  start: number;
  /** El lado que mide `ratio × span`: de su tamaño en pantalla sale `span`. */
  sized: Element | null;
  /** 1 si el ratio crece al mover el cursor a la derecha (o abajo); -1 si crece al revés. */
  sign: 1 | -1;
  onRatio: (ratio: number) => void;
  onEnd: () => void;
}

/** Desde un `pointerdown` en el divisor: captura el puntero y aplica un ratio por frame hasta soltar. */
export function startDividerDrag(handle: HTMLElement, event: { clientX: number; clientY: number; pointerId: number }, drag: DividerDrag) {
  const origin = drag.axis === "x" ? event.clientX : event.clientY;
  const box = drag.sized?.getBoundingClientRect();
  const size = box ? (drag.axis === "x" ? box.width : box.height) : 0;
  const span = drag.start > 0 ? size / drag.start : 0;
  handle.setPointerCapture(event.pointerId);
  let frame = 0;
  const onMove = (ev: PointerEvent) => {
    const moved = (drag.axis === "x" ? ev.clientX : ev.clientY) - origin;
    cancelAnimationFrame(frame);
    // Un cambio por frame; el ResizeObserver de cada terminal hace el fit.
    frame = requestAnimationFrame(() => drag.onRatio(draggedRatio(drag.start, moved, span, drag.sign)));
  };
  const onEnd = () => {
    cancelAnimationFrame(frame);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    drag.onEnd();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
}
