import type React from "react";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { dropZoneAt, findPane } from "./layout";

/** Píxeles que hay que mover el puntero para que un clic en la barra se vuelva arrastre. */
const DRAG_THRESHOLD = 5;

/** El panel de la pestaña activa bajo el puntero (nunca una shell acoplada ni otra pestaña). */
function paneAt(x: number, y: number): { id: string; box: DOMRect } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane-id]");
  const id = el?.dataset.paneId;
  if (!el || !id) return null;
  const { tabs, activeTabId } = useTerminalStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab && findPane(tab.root, id) ? { id, box: el.getBoundingClientRect() } : null;
}

/**
 * Arrastrar un panel por su barra. Pasado el umbral, cada movimiento dice
 * sobre qué panel y en qué zona caería (lo pinta el panel de destino); al
 * soltar se mueve. Esc, o perder el puntero, lo cancela. La barra captura el
 * puntero: los programas con ratón (vim, Claude Code) no ven el arrastre.
 */
export function startPaneDrag(sourceId: string, event: React.PointerEvent<HTMLElement>) {
  const handle = event.currentTarget;
  const { pointerId } = event;
  const origin = { x: event.clientX, y: event.clientY };
  const ui = useUiStore.getState;
  let dragging = false;

  const onMove = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < DRAG_THRESHOLD) return;
      dragging = true;
      document.documentElement.dataset.paneDragging = "";
    }
    const over = paneAt(e.clientX, e.clientY);
    const target = over && over.id !== sourceId ? over : null;
    ui().setPaneDrag({
      sourceId,
      targetId: target?.id ?? null,
      zone: target ? dropZoneAt(target.box, e.clientX, e.clientY) : null,
    });
  };

  const finish = (commit: boolean) => {
    const drag = ui().paneDrag;
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    delete document.documentElement.dataset.paneDragging;
    ui().setPaneDrag(null);
    if (commit && drag?.targetId && drag.zone) useTerminalStore.getState().movePane(sourceId, drag.targetId, drag.zone);
  };
  const onUp = () => finish(dragging);
  const onCancel = () => finish(false);
  // En captura: el Esc no llega a la terminal (ni a vim) mientras se arrastra.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };

  try {
    handle.setPointerCapture(pointerId);
  } catch {
    // El puntero ya no existe (se soltó antes de llegar aquí): no hay arrastre.
    return;
  }
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
