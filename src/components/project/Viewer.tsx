import React, { useEffect, useRef } from "react";
import { useProjectStore } from "../../store/projectStore";
import { closeViewer, stepDiff } from "../../lib/project";
import { DiffView } from "./viewer/DiffView";
import { FileView } from "./viewer/FileView";
import { ConflictView } from "./viewer/ConflictView";
import { OutputView } from "./viewer/OutputView";

/** Hoja sobre el área de terminales: diff de un archivo o vista previa. Esc cierra. */
export const Viewer: React.FC = () => {
  const viewer = useProjectStore((s) => s.viewer);
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

  return (
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
        }
      }}
      className="absolute inset-0 z-30 flex animate-fade-in flex-col overflow-hidden rounded-xl border border-line bg-canvas"
    >
      {viewer.kind === "diff" && <DiffView viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "file" && <FileView viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "conflict" && <ConflictView key={viewer.path} viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "output" && <OutputView key={viewer.id} viewer={viewer} bodyRef={bodyRef} />}
    </div>
  );
};
