import React, { useState } from "react";
import type { LayoutNode, SplitNode } from "../types/layout";
import { TerminalPane } from "./TerminalPane";
import { findPane } from "../lib/layout";
import { startDividerDrag } from "../lib/dividerDrag";
import { useTerminalStore } from "../store/terminalStore";

interface SplitViewProps {
  node: LayoutNode;
  activePaneId: string;
  isRoot?: boolean;
  /** Si hay un panel maximizado, solo se pinta ese. */
  zoomedPaneId?: string | null;
}

/**
 * Despachador sin hooks. Antes los hooks vivían después de un `return`
 * condicional: al convertir un panel en split, React veía más hooks que en el
 * render anterior y reventaba.
 */
export const SplitView: React.FC<SplitViewProps> = ({ node, activePaneId, isRoot = true, zoomedPaneId }) => {
  if (zoomedPaneId) {
    const zoomed = findPane(node, zoomedPaneId);
    // El resto de paneles se desmonta; sus terminales siguen vivos y vuelven intactos.
    // `key` = id del panel: si un panel se reemplaza por otro en el mismo sitio (reanudar un
    // agente), React debe montarlo de cero. Si no, el nuevo heredaría la spec de arranque del viejo.
    if (zoomed) return <TerminalPane key={zoomed.id} pane={zoomed} isActive isSplit={false} isZoomed />;
  }
  if (node.type === "pane") {
    return <TerminalPane key={node.id} pane={node} isActive={node.id === activePaneId} isSplit={!isRoot} />;
  }
  return <SplitContainer node={node} activePaneId={activePaneId} />;
};

const KEYBOARD_STEP = 0.05;

const SplitContainer: React.FC<{ node: SplitNode; activePaneId: string }> = ({ node, activePaneId }) => {
  const [isDragging, setIsDragging] = useState(false);
  const updateSplitRatio = useTerminalStore((s) => s.updateSplitRatio);

  const isRow = node.direction === "horizontal";

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    // El primer lado mide `ratio` de lo que se reparten los dos.
    startDividerDrag(e.currentTarget, e, {
      axis: isRow ? "x" : "y",
      start: node.ratio,
      sized: e.currentTarget.previousElementSibling,
      sign: 1,
      onRatio: (ratio) => updateSplitRatio(node.id, ratio),
      onEnd: () => setIsDragging(false),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const decrease = isRow ? "ArrowLeft" : "ArrowUp";
    const increase = isRow ? "ArrowRight" : "ArrowDown";
    if (e.key !== decrease && e.key !== increase) return;
    e.preventDefault();
    updateSplitRatio(node.id, node.ratio + (e.key === increase ? KEYBOARD_STEP : -KEYBOARD_STEP));
  };

  return (
    <div className={`flex h-full w-full min-h-0 min-w-0 ${isRow ? "flex-row" : "flex-col"}`}>
      <div className="relative min-h-0 min-w-0 overflow-hidden" style={{ flex: `${node.ratio} 1 0px` }}>
        <SplitView node={node.first} activePaneId={activePaneId} isRoot={false} />
      </div>

      <div
        role="separator"
        tabIndex={0}
        aria-label="Redimensionar paneles"
        aria-orientation={isRow ? "vertical" : "horizontal"}
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(node.ratio * 100)}
        data-dragging={isDragging || undefined}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className="divider z-10"
      />

      <div className="relative min-h-0 min-w-0 overflow-hidden" style={{ flex: `${1 - node.ratio} 1 0px` }}>
        <SplitView node={node.second} activePaneId={activePaneId} isRoot={false} />
      </div>
    </div>
  );
};
