import React, { useEffect, useRef, useState } from "react";
import { useProjectStore } from "../../store/projectStore";
import { closeViewer, cycleFileTab, projectRoot, setViewerDockWidth, stepDiff } from "../../lib/project";
import { cn } from "../../lib/layout";
import { FileTabs } from "./viewer/FileTabs";
import { DiffView } from "./viewer/DiffView";
import { FileView } from "./viewer/FileView";
import { ConflictView } from "./viewer/ConflictView";
import { OutputView } from "./viewer/OutputView";

const KEYBOARD_STEP = 0.05;

/**
 * Divisor entre las terminales y el visor acoplado (como el de los paneles).
 * Arrastrar cambia el ancho; doble clic lo deja a la mitad.
 */
const DockDivider: React.FC<{ width: number }> = ({ width }) => {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const area = e.currentTarget.closest("main");
    if (e.button !== 0 || !area) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const rect = area.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    let frame = 0;
    const onMove = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      // Un cambio por frame; el ResizeObserver de cada terminal hace el fit.
      frame = requestAnimationFrame(() => setViewerDockWidth((rect.right - ev.clientX) / rect.width));
    };
    const onEnd = () => {
      cancelAnimationFrame(frame);
      setDragging(false);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Ancho del visor"
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(width * 100)}
      title="Arrastra para cambiar el ancho · doble clic: a la mitad"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setViewerDockWidth(0.5)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        // El divisor está a la izquierda del visor: ← lo agranda.
        setViewerDockWidth(width + (e.key === "ArrowLeft" ? KEYBOARD_STEP : -KEYBOARD_STEP));
      }}
      className="divider z-10"
    />
  );
};

/**
 * Diff de un archivo, el archivo o la salida de un comando. Encima de las
 * terminales, o acoplado a su lado para verlas a la vez (al agente que lo
 * edita, por ejemplo). Esc cierra.
 */
export const Viewer: React.FC = () => {
  const viewer = useProjectStore((s) => s.viewer);
  const dock = useProjectStore((s) => s.viewerDock);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const target = viewer
    ? viewer.kind === "diff"
      ? viewer.source
      : viewer.kind === "output"
        ? `output:${viewer.id}`
        : `${viewer.kind}:${viewer.path}`
    : null;
  useEffect(() => {
    // El foco pasa al visor: las teclas dejan de ir a la terminal.
    if (target) bodyRef.current?.focus();
  }, [target]);

  if (!viewer) return null;
  const root = projectRoot();

  const sheet = (
    <div
      role="dialog"
      aria-label={
        viewer.kind === "diff"
          ? `Diff de ${viewer.source.path}`
          : viewer.kind === "conflict"
            ? `Conflicto en ${viewer.path}`
            : viewer.kind === "output"
              ? `Salida de ${viewer.command}`
              : `Archivo ${viewer.path}`
      }
      data-viewer
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (e.defaultPrevented) return;
          e.preventDefault();
          closeViewer();
        } else if (viewer.kind === "diff" && e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          stepDiff(e.key === "ArrowDown" ? 1 : -1);
        } else if (viewer.kind === "file" && e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
          // ⌃Tab / ⌃⇧Tab: pestaña siguiente / anterior.
          e.preventDefault();
          cycleFileTab(e.shiftKey ? -1 : 1);
        }
      }}
      className={cn(
        "@container flex animate-fade-in flex-col overflow-hidden rounded-xl border border-line bg-canvas",
        dock.docked ? "relative h-full min-w-0 flex-1" : "absolute inset-0 z-30",
      )}
    >
      {viewer.kind === "diff" && <DiffView viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "file" && root && <FileTabs root={root} active={viewer.path} />}
      {viewer.kind === "file" && <FileView viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "conflict" && <ConflictView key={viewer.path} viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "output" && <OutputView key={viewer.id} viewer={viewer} bodyRef={bodyRef} />}
    </div>
  );

  // Mismo árbol acoplado o no (el contenedor sin caja cuando va encima): si cambiara,
  // React rehace el visor, el editor se vuelve a crear y le quita el foco a la terminal.
  return (
    <div className={dock.docked ? "flex h-full shrink-0" : "contents"} style={dock.docked ? { width: `${dock.width * 100}%` } : undefined}>
      {dock.docked && <DockDivider key="divider" width={dock.width} />}
      <React.Fragment key="sheet">{sheet}</React.Fragment>
    </div>
  );
};
