import React, { useRef, useState } from "react";
import type { LayoutNode, SplitNode } from "../types/layout";
import { TerminalPane } from "./TerminalPane";
import { findPane } from "../lib/layout";
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const updateSplitRatio = useTerminalStore((s) => s.updateSplitRatio);

  const isRow = node.direction === "horizontal";

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (e.button !== 0 || !container) return;
    e.preventDefault();

    const handle = e.currentTarget;
    const rect = container.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    setIsDragging(true);

    let frame = 0;
    const onMove = (ev: PointerEvent) => {
      const ratio = isRow ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      cancelAnimationFrame(frame);
      // Un update por frame; el ResizeObserver de cada panel hace el fit.
      frame = requestAnimationFrame(() => updateSplitRatio(node.id, ratio));
    };
    const onEnd = () => {
      cancelAnimationFrame(frame);
      setIsDragging(false);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const decrease = isRow ? "ArrowLeft" : "ArrowUp";
    const increase = isRow ? "ArrowRight" : "ArrowDown";
    if (e.key !== decrease && e.key !== increase) return;
    e.preventDefault();
    updateSplitRatio(node.id, node.ratio + (e.key === increase ? KEYBOARD_STEP : -KEYBOARD_STEP));
  };

  return (
    <div ref={containerRef} className={`flex h-full w-full min-h-0 min-w-0 ${isRow ? "flex-row" : "flex-col"}`}>
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
