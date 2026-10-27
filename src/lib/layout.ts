import type { LayoutNode, PaneNode, Tab } from "../types/layout";

/** Paneles de un árbol en orden visual (izquierda→derecha, arriba→abajo). */
export function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.type === "pane") return [node];
  return [...collectPanes(node.first), ...collectPanes(node.second)];
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | undefined {
  if (node.type === "pane") return node.id === paneId ? node : undefined;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

export function findOwnerTab(tabs: Tab[], paneId: string): Tab | undefined {
  return tabs.find((tab) => findPane(tab.root, paneId));
}

/** Etiqueta visible de una pestaña: su nombre manual o el título vivo de su panel activo. */
export function tabLabel(tab: Tab): string {
  return tab.customTitle || findPane(tab.root, tab.activePaneId)?.title || tab.title;
}

/** Todas las proporciones a 50/50. */
export function equalize(node: LayoutNode): LayoutNode {
  if (node.type === "pane") return node;
  return { ...node, ratio: 0.5, first: equalize(node.first), second: equalize(node.second) };
}

export function replacePane(
  node: LayoutNode,
  paneId: string,
  transform: (pane: PaneNode) => LayoutNode,
): LayoutNode {
  if (node.type === "pane") return node.id === paneId ? transform(node) : node;
  const first = replacePane(node.first, paneId, transform);
  const second = replacePane(node.second, paneId, transform);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Quita un panel; su hermano ocupa el lugar del split. `null` si el árbol queda vacío. */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "pane") return node.id === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Lado de un panel. */
export type PaneSide = "left" | "right" | "top" | "bottom";
/** Dónde se suelta un panel sobre otro: pegado a un lado o en su lugar (intercambio). */
export type DropZone = PaneSide | "center";

/** Intercambia dos paneles de sitio; cada split conserva su forma y sus proporciones. */
export function swapPanes(node: LayoutNode, aId: string, bId: string): LayoutNode {
  const a = findPane(node, aId);
  const b = findPane(node, bId);
  if (!a || !b || a === b) return node;
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === "pane") return n.id === aId ? b : n.id === bId ? a : n;
    return { ...n, first: walk(n.first), second: walk(n.second) };
  };
  return walk(node);
}

/**
 * Mueve `sourceId` junto a `targetId`: en `center` se intercambian; en un
 * lado, el origen sale de donde estaba (su hermano ocupa el hueco) y parte al
 * destino a la mitad, de ese lado. `splitId` es el id del split nuevo. Sin
 * cambios (mismo panel o alguno que no está) devuelve el mismo árbol.
 */
export function movePane(node: LayoutNode, sourceId: string, targetId: string, zone: DropZone, splitId: string): LayoutNode {
  if (sourceId === targetId) return node;
  if (zone === "center") return swapPanes(node, sourceId, targetId);
  const source = findPane(node, sourceId);
  const rest = removePane(node, sourceId);
  if (!source || !rest || !findPane(rest, targetId)) return node;
  const before = zone === "left" || zone === "top";
  return replacePane(rest, targetId, (target) => ({
    id: splitId,
    type: "split",
    direction: zone === "left" || zone === "right" ? "horizontal" : "vertical",
    ratio: 0.5,
    first: before ? source : target,
    second: before ? target : source,
  }));
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Dónde queda cada panel dentro de la pestaña, en fracciones (0–1) de su ancho y alto. */
export function paneRects(node: LayoutNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }): Array<{ id: string; rect: Rect }> {
  if (node.type === "pane") return [{ id: node.id, rect }];
  const row = node.direction === "horizontal";
  const first = row ? { ...rect, w: rect.w * node.ratio } : { ...rect, h: rect.h * node.ratio };
  const second = row
    ? { x: rect.x + first.w, y: rect.y, w: rect.w - first.w, h: rect.h }
    : { x: rect.x, y: rect.y + first.h, w: rect.w, h: rect.h - first.h };
  return [...paneRects(node.first, first), ...paneRects(node.second, second)];
}

const EPSILON = 1e-6;

/**
 * El panel que toca a `paneId` por ese lado (comparten borde y se solapan en
 * el otro eje). Si hay varios, el más alineado con su centro.
 */
export function neighbourPane(node: LayoutNode, paneId: string, side: PaneSide): string | null {
  const rects = paneRects(node);
  const from = rects.find((r) => r.id === paneId)?.rect;
  if (!from) return null;
  const horizontal = side === "left" || side === "right";
  const overlaps = (r: Rect) =>
    horizontal
      ? Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y) > EPSILON
      : Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x) > EPSILON;
  const touches = (r: Rect) => {
    if (side === "left") return Math.abs(r.x + r.w - from.x) < EPSILON;
    if (side === "right") return Math.abs(from.x + from.w - r.x) < EPSILON;
    if (side === "top") return Math.abs(r.y + r.h - from.y) < EPSILON;
    return Math.abs(from.y + from.h - r.y) < EPSILON;
  };
  const centre = (r: Rect) => (horizontal ? r.y + r.h / 2 : r.x + r.w / 2);
  const found = rects
    .filter((r) => r.id !== paneId && touches(r.rect) && overlaps(r.rect))
    .sort((a, b) => Math.abs(centre(a.rect) - centre(from)) - Math.abs(centre(b.rect) - centre(from)));
  return found[0]?.id ?? null;
}

/** Fracción de cada borde que cuenta como "pegarlo de ese lado"; el resto del panel es intercambiar. */
const EDGE = 0.3;

/** Zona de un panel bajo el puntero (`box`: su rectángulo en pantalla). */
export function dropZoneAt(box: { left: number; top: number; width: number; height: number }, x: number, y: number): DropZone {
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  const distances: Array<[PaneSide, number]> = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  const [side, distance] = distances.reduce((best, d) => (d[1] < best[1] ? d : best));
  return distance < EDGE ? side : "center";
}

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export function setSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) {
    const clamped = Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO);
    return clamped === node.ratio ? node : { ...node, ratio: clamped };
  }
  const first = setSplitRatio(node.first, splitId, ratio);
  const second = setSplitRatio(node.second, splitId, ratio);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export { basename } from "./paths";
