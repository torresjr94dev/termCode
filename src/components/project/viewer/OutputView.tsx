import React, { useEffect, useRef, useState } from "react";
import { Copy, Search, Sparkles, SquareTerminal, X } from "lucide-react";
import type { Viewer as ViewerState } from "../../../store/projectStore";
import { useUiStore } from "../../../store/uiStore";
import { closeViewer } from "../../../lib/project";
import { explainFailure } from "../../../lib/output";
import { formatDuration } from "../../../lib/format";
import { cn } from "../../../lib/layout";
import { sysLabel } from "../../../lib/shortcuts";
import { IconButton, Kbd } from "../../ui";
import { Notice } from "./parts";

type EditorHandle = ReturnType<(typeof import("../../../editor/codemirror"))["createEditor"]>;

/**
 * La salida completa de un comando, en el mismo editor que los archivos (solo
 * lectura): se recorre entera, se busca con ⌘F y se copia sin pelear con el
 * scroll de la terminal.
 */
export const OutputView: React.FC<{
  viewer: Extract<ViewerState, { kind: "output" }>;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, bodyRef }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useUiStore((s) => s.showToast);
  const failed = !viewer.running && viewer.exitCode !== 0;
  const lines = viewer.text ? viewer.text.split("\n").length : 0;

  useEffect(() => {
    let disposed = false;
    import("../../../editor/codemirror")
      .then(({ createEditor }) => {
        if (disposed || !hostRef.current) return;
        editorRef.current = createEditor(hostRef.current, {
          doc: viewer.text,
          // Sin extensión conocida: texto plano, sin resaltar como si fuera código.
          path: "salida.txt",
          readOnly: true,
          onDirtyChange: () => {},
          onSave: () => {},
        });
        setReady(true);
        editorRef.current.focus();
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      disposed = true;
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [viewer.text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(viewer.text);
      toast("Salida copiada.");
    } catch {
      toast("No se pudo copiar.", "error");
    }
  };

  const state = viewer.running ? "corriendo" : failed ? `✗ código ${viewer.exitCode ?? "?"}` : "✓ código 0";

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-chrome pl-3 pr-1.5">
        <SquareTerminal size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
        <span className="min-w-0 truncate font-mono text-[12.5px] text-ink" title={viewer.command}>
          {viewer.command || "(comando sin texto)"}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-sm border px-1.5 font-mono text-[11px] leading-5",
            failed ? "border-del/50 text-del" : viewer.running ? "border-accent/50 text-accent" : "border-line text-ink-3",
          )}
        >
          {state} · {formatDuration(viewer.durationMs)} · {lines} {lines === 1 ? "línea" : "líneas"}
        </span>
        <span className="flex-1" />
        <span className="hidden items-center gap-1.5 font-sans text-[11.5px] text-ink-3 md:flex">
          <Search size={12} strokeWidth={1.9} aria-hidden="true" />
          Buscar <Kbd>{sysLabel("F")}</Kbd>
        </span>
        {failed && (
          <button
            type="button"
            onClick={() => {
              explainFailure(viewer.paneId);
              closeViewer();
            }}
            title="Manda el comando y el final de su salida al agente"
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 font-sans text-[12px] font-medium text-on-accent transition-opacity duration-150 hover:opacity-90"
          >
            <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
            Explicar este error
          </button>
        )}
        <IconButton icon={Copy} label="Copiar la salida" size="sm" onClick={() => void copy()} />
        <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        <IconButton icon={X} label="Cerrar" shortcut="esc" size="sm" onClick={closeViewer} />
      </div>
      {(viewer.truncated || viewer.cwd) && (
        <p className="shrink-0 truncate border-b border-line bg-raised px-4 py-1.5 font-mono text-[11.5px] text-ink-3">
          {viewer.cwd}
          {viewer.truncated && " · salida de más de 2 MB: aquí va el principio"}
        </p>
      )}
      {loadError && <Notice tone="error">No se pudo cargar el visor: {loadError}</Notice>}
      {!viewer.text && <Notice>El comando no imprimió nada (o su salida ya salió del historial de la terminal).</Notice>}
      <div
        ref={bodyRef}
        tabIndex={-1}
        // Solo lectura: Esc cierra (antes de que CodeMirror se lo quede), salvo con la búsqueda
        // abierta, que se cierra primero.
        onKeyDownCapture={(e) => {
          if (e.key !== "Escape" || hostRef.current?.querySelector(".cm-search")) return;
          e.preventDefault();
          e.stopPropagation();
          closeViewer();
        }}
        className={cn("relative min-h-0 flex-1 outline-none", !viewer.text && "hidden")}
      >
        <div ref={hostRef} className="absolute inset-0" />
        {!ready && !loadError && <p className="absolute left-4 top-4 font-sans text-[13px] text-ink-3">Abriendo…</p>}
      </div>
    </>
  );
};
