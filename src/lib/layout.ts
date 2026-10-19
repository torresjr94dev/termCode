import type { LayoutNode, PaneNode, Tab } from "../types/layout";

/** Paneles de un árbol en orden visual (izquierda→derecha, arriba→abajo). */
export function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.type === "pane") return [node];
  return [...collectPanes(node.first), ...collectPanes(node.second)];
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | undefined {
  return collectPanes(node).find((pane) => pane.id === paneId);
}

/** Etiqueta visible de una pestaña: el título vivo de su panel activo. */
export function tabLabel(tab: Tab): string {
  return findPane(tab.root, tab.activePaneId)?.title || tab.title;
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
