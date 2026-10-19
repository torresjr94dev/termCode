import React, { useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronUp, Columns2, Copy, CornerDownLeft, FileText, FolderOpen, Rows3, X } from "lucide-react";
import { useProjectStore, sameSource, type DiffSource, type Viewer as ViewerState } from "../../store/projectStore";
import { useUiStore } from "../../store/uiStore";
import { closeViewer, pastePath, stepDiff } from "../../lib/project";
import { parseUnifiedDiff, toSplitRows, type DiffRow } from "../../lib/diff";
import { IS_TAURI } from "../../lib/ipc";
import { cn } from "../../lib/layout";
import { IconButton, Kbd } from "../ui";
import { splitPath } from "./common";

const ROW_CAP = 3000;
type Mode = "unified" | "split";

function loadMode(): Mode {
  try {
    return localStorage.getItem("termcode.diffMode") === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function saveMode(mode: Mode) {
  try {
    localStorage.setItem("termcode.diffMode", mode);
  } catch {
    // Almacenamiento no disponible: la preferencia solo dura esta sesión.
  }
}

const SOURCE_LABEL: Record<DiffSource["kind"], string> = {
  staged: "Preparado",
  worktree: "Sin preparar",
  untracked: "Archivo nuevo",
  commit: "Commit",
};

/** Hoja sobre el área de terminales: diff de un archivo o vista previa. Esc cierra. */
export const Viewer: React.FC = () => {
  const viewer = useProjectStore((s) => s.viewer);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const target = viewer ? (viewer.kind === "diff" ? viewer.source : viewer.path) : null;
  useEffect(() => {
    // El foco pasa al visor: las teclas dejan de ir a la terminal.
    if (target) bodyRef.current?.focus();
  }, [target]);

  if (!viewer) return null;

  return (
    <div
      role="dialog"
      aria-label={viewer.kind === "diff" ? `Diff de ${viewer.source.path}` : `Archivo ${viewer.path}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeViewer();
        } else if (viewer.kind === "diff" && e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          stepDiff(e.key === "ArrowDown" ? 1 : -1);
        }
      }}
      className="absolute inset-0 z-30 flex animate-fade-in flex-col bg-canvas"
    >
      {viewer.kind === "diff" ? <DiffView viewer={viewer} bodyRef={bodyRef} /> : <FileView viewer={viewer} bodyRef={bodyRef} />}
    </div>
  );
};

/* ------------------------------------------------------------------ */

const Header: React.FC<{ path: string; badge: string; children?: React.ReactNode }> = ({ path, badge, children }) => {
  const { name, dir } = splitPath(path);
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-chrome pl-3 pr-1.5">
      <FileText size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="flex min-w-0 items-baseline gap-2 font-mono">
        <span className="shrink-0 text-[12.5px] text-ink">{name}</span>
        <span className="min-w-0 truncate text-[11px] text-ink-3">{dir}</span>
      </span>
      <span className="shrink-0 rounded-sm border border-line px-1.5 font-mono text-[11px] leading-5 text-ink-3">{badge}</span>
      <span className="flex-1" />
      {children}
      <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
      <IconButton icon={X} label="Cerrar" shortcut="esc" size="sm" onClick={closeViewer} />
    </div>
  );
};

const Body: React.FC<{ bodyRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }> = ({ bodyRef, children }) => (
  <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 select-text overflow-auto font-mono text-[12px] leading-[20px] outline-none">
    {children}
  </div>
);

const Notice: React.FC<{ children: React.ReactNode; tone?: "error" }> = ({ children, tone }) => (
  <p className={cn("px-4 py-6 font-sans text-[13px]", tone === "error" ? "text-signal" : "text-ink-3")}>{children}</p>
);

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

const DiffView: React.FC<{
  viewer: Extract<ViewerState, { kind: "diff" }>;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, bodyRef }) => {
  const [mode, setMode] = useState<Mode>(loadMode);
  const [showAll, setShowAll] = useState(false);
  const parsed = useMemo(() => (viewer.text === undefined ? null : parseUnifiedDiff(viewer.text)), [viewer.text]);
  const index = viewer.siblings.findIndex((s) => sameSource(s, viewer.source));
  const badge = viewer.source.kind === "commit" ? `Commit ${viewer.source.short}` : SOURCE_LABEL[viewer.source.kind];

  const switchMode = (next: Mode) => {
    setMode(next);
    saveMode(next);
  };

  const rows = parsed ? (showAll ? parsed.rows : parsed.rows.slice(0, ROW_CAP)) : [];
  const hidden = parsed ? parsed.rows.length - rows.length : 0;

  return (
    <>
      <Header path={viewer.source.path} badge={badge}>
        {parsed && (
          <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
            <span className="text-add">+{parsed.additions}</span>
            <span className="text-del">−{parsed.deletions}</span>
          </span>
        )}
        <div role="radiogroup" aria-label="Vista del diff" className="flex rounded-md border border-line p-0.5">
          {(
            [
              ["unified", Rows3, "Unificado"],
              ["split", Columns2, "Lado a lado"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              title={label}
              onClick={() => switchMode(id)}
              className={cn(
                "grid h-6 w-7 place-items-center rounded-[4px] transition-colors duration-150",
                mode === id ? "bg-press text-ink" : "text-ink-3 hover:text-ink-2",
              )}
            >
              <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ))}
        </div>
        {viewer.siblings.length > 1 && (
          <span className="flex items-center">
            <IconButton icon={ChevronUp} label="Archivo anterior" shortcut="⌥↑" size="sm" disabled={index <= 0} onClick={() => stepDiff(-1)} />
            <span className="w-10 text-center font-mono text-[11px] tabular-nums text-ink-3">
              {index + 1}/{viewer.siblings.length}
            </span>
            <IconButton
              icon={ChevronDown}
              label="Archivo siguiente"
              shortcut="⌥↓"
              size="sm"
              disabled={index >= viewer.siblings.length - 1}
              onClick={() => stepDiff(1)}
            />
          </span>
        )}
      </Header>
      <Body bodyRef={bodyRef}>
        {viewer.error && <Notice tone="error">{viewer.error}</Notice>}
        {!viewer.error && !parsed && <Notice>Calculando diff…</Notice>}
        {parsed?.binary && <Notice>Archivo binario: no hay diff de texto que mostrar.</Notice>}
        {parsed && !parsed.binary && !parsed.rows.length && <Notice>Sin diferencias de contenido (¿solo permisos?).</Notice>}
        {parsed && rows.length > 0 && (mode === "unified" ? <UnifiedRows rows={rows} /> : <SplitRows rows={rows} />)}
        {(hidden > 0 || viewer.truncated) && (
          <div className="flex items-center gap-3 px-4 py-4 font-sans text-[12px] text-ink-3">
            {hidden > 0 && (
              <button type="button" onClick={() => setShowAll(true)} className="rounded-md border border-line px-2.5 py-1 text-ink-2 hover:bg-hover">
                Mostrar {hidden.toLocaleString("es-MX")} líneas más
              </button>
            )}
            {viewer.truncated && <span>El diff es muy grande: se muestran los primeros 2 MB.</span>}
          </div>
        )}
      </Body>
    </>
  );
};

const ROW_BG: Record<DiffRow["kind"], string> = {
  add: "bg-add/[0.08]",
  del: "bg-del/[0.08]",
  context: "",
  hunk: "bg-raised text-ink-3",
  meta: "text-ink-3",
};

const GUTTER_BG: Record<DiffRow["kind"], string> = {
  add: "bg-add/[0.14] text-add/80",
  del: "bg-del/[0.14] text-del/80",
  context: "text-ink-3/70",
  hunk: "text-ink-3",
  meta: "text-ink-3",
};

/** Texto con el tramo cambiado resaltado. */
const Code: React.FC<{ row: DiffRow }> = ({ row }) => {
  if (!row.changed) return <>{row.text || " "}</>;
  const [start, end] = row.changed;
  const mark = row.kind === "add" ? "bg-add/30 text-ink" : "bg-del/30 text-ink";
  return (
    <>
      {row.text.slice(0, start)}
      <mark className={cn("rounded-[2px] text-inherit", mark)}>{row.text.slice(start, end)}</mark>
      {row.text.slice(end)}
    </>
  );
};

const SIGN: Partial<Record<DiffRow["kind"], string>> = { add: "+", del: "−" };

const UnifiedRows: React.FC<{ rows: DiffRow[] }> = ({ rows }) => (
  <div className="w-max min-w-full pb-6">
    {rows.map((row, i) =>
      row.kind === "hunk" || row.kind === "meta" ? (
        <div key={i} className={cn("flex min-w-full px-4 py-0.5", ROW_BG[row.kind], row.kind === "hunk" && "mt-2 first:mt-0")}>
          <span className="whitespace-pre text-[11.5px]">{row.kind === "hunk" ? `@@ ${row.text}` : row.text}</span>
        </div>
      ) : (
        <div key={i} className={cn("flex min-w-full", ROW_BG[row.kind])}>
          <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", GUTTER_BG[row.kind])}>{row.oldNo ?? ""}</span>
          <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", GUTTER_BG[row.kind])}>{row.newNo ?? ""}</span>
          <span className={cn("w-6 shrink-0 select-none text-center", row.kind === "add" ? "text-add" : "text-del")}>{SIGN[row.kind] ?? ""}</span>
          <span className="whitespace-pre pr-6 text-ink">
            <Code row={row} />
          </span>
        </div>
      ),
    )}
  </div>
);

const SplitCell: React.FC<{ row?: DiffRow; side: "left" | "right" }> = ({ row, side }) => {
  const no = side === "left" ? row?.oldNo : row?.newNo;
  const kind = row?.kind ?? "context";
  return (
    <div className={cn("flex min-w-0 flex-1", row ? ROW_BG[kind] : "bg-raised/40")}>
      <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", row ? GUTTER_BG[kind] : "")}>{no ?? ""}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 text-ink">{row && <Code row={row} />}</span>
    </div>
  );
};

const SplitRows: React.FC<{ rows: DiffRow[] }> = ({ rows }) => {
  const split = useMemo(() => toSplitRows(rows), [rows]);
  return (
    <div className="min-w-full pb-6">
      {split.map((r, i) =>
        r.full ? (
          <div key={i} className={cn("px-4 py-0.5 whitespace-pre text-[11.5px]", ROW_BG[r.full.kind], r.full.kind === "hunk" && "mt-2 first:mt-0")}>
            {r.full.kind === "hunk" ? `@@ ${r.full.text}` : r.full.text}
          </div>
        ) : (
          <div key={i} className="flex">
            <SplitCell row={r.left} side="left" />
            <span className="w-px shrink-0 bg-line" aria-hidden="true" />
            <SplitCell row={r.right} side="right" />
          </div>
        ),
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Archivo                                                             */
/* ------------------------------------------------------------------ */

const LINE_CAP = 5000;

const FileView: React.FC<{
  viewer: Extract<ViewerState, { kind: "file" }>;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, bodyRef }) => {
  const preview = viewer.preview;
  const lines = useMemo(() => (preview && !preview.binary ? preview.text.split("\n") : []), [preview]);
  const shown = lines.slice(0, LINE_CAP);
  const toast = useUiStore((s) => s.showToast);

  const copyPath = async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.absolute);
      toast("Ruta copiada.");
    } catch {
      toast("No se pudo copiar la ruta.", "error");
    }
  };

  return (
    <>
      <Header path={viewer.path} badge={preview ? `${(preview.size / 1024).toFixed(preview.size < 10240 ? 1 : 0)} KB` : "Archivo"}>
        {preview && (
          <>
            <IconButton icon={CornerDownLeft} label="Pegar la ruta en la terminal" size="sm" onClick={() => pastePath(preview.absolute)} />
            <IconButton icon={Copy} label="Copiar ruta" size="sm" onClick={() => void copyPath()} />
            {IS_TAURI && (
              <IconButton
                icon={FolderOpen}
                label="Mostrar en Finder"
                size="sm"
                onClick={() => void revealItemInDir(preview.absolute).catch(() => toast("No se pudo abrir Finder.", "error"))}
              />
            )}
          </>
        )}
      </Header>
      <Body bodyRef={bodyRef}>
        {viewer.error && <Notice tone="error">{viewer.error}</Notice>}
        {!viewer.error && !preview && <Notice>Abriendo…</Notice>}
        {preview?.binary && <Notice>Archivo binario: no se puede previsualizar.</Notice>}
        {shown.length > 0 && (
          <div className="w-max min-w-full py-2 pb-6">
            {shown.map((line, i) => (
              <div key={i} className="flex min-w-full hover:bg-hover/50">
                <span className="w-14 shrink-0 select-none pr-3 text-right tabular-nums text-ink-3/70">{i + 1}</span>
                <span className="whitespace-pre pr-6 text-ink">{line || " "}</span>
              </div>
            ))}
          </div>
        )}
        {(preview?.truncated || lines.length > LINE_CAP) && (
          <Notice>
            Vista previa recortada ({preview?.truncated ? "primeros 512 KB" : `primeras ${LINE_CAP.toLocaleString("es-MX")} líneas`}).
            Ábrelo en tu editor para verlo completo. <Kbd>esc</Kbd> cierra.
          </Notice>
        )}
      </Body>
    </>
  );
};
