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

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || "/";
}
