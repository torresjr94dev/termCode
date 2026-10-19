import React, { useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  CornerDownLeft,
  FileText,
  FolderOpen,
  GitMerge,
  Minus,
  Plus,
  Rows3,
  SquarePen,
  X,
} from "lucide-react";
import { useProjectStore, sameSource, type DiffSource, type Viewer as ViewerState } from "../../store/projectStore";
import { useUiStore } from "../../store/uiStore";
import {
  absolutePath,
  closeViewer,
  confirmHunk,
  fileChangedOnDisk,
  hunkActions,
  notifyUnsaved,
  openInEditor,
  pastePath,
  registerUnsaved,
  reloadFile,
  saveConflict,
  saveFile,
  stepDiff,
  type HunkAction,
} from "../../lib/project";
import type { FilePreview } from "../../lib/git";
import { hunkPatch, parseUnifiedDiff, toSplitRows, type DiffRow } from "../../lib/diff";
import { useHighlighter, type Segment } from "../../lib/highlight";
import { conflictCount, parseConflicts, resolveConflicts, type Choice, type ConflictChunk } from "../../lib/conflicts";
import { IS_TAURI } from "../../lib/ipc";
import { cn } from "../../lib/layout";
import { IconButton, Kbd } from "../ui";
import { splitPath } from "./common";

const ROW_CAP = 3000;
const HIGHLIGHT_ROWS = 6000;
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
  review: "Cambios del agente",
};

const HUNK_LABEL: Record<HunkAction, string> = {
  stage: "Preparar",
  unstage: "Quitar del índice",
  discard: "Descartar",
  revert: "Revertir",
};

type OnHunk = ((index: number, action: HunkAction) => void) | null;

/** Botones de un fragmento (a la derecha de su cabecera @@). */
const HunkButtons: React.FC<{ index?: number; actions: HunkAction[]; onHunk: OnHunk }> = ({ index, actions, onHunk }) => {
  if (index === undefined || !onHunk || !actions.length) return null;
  return (
    <span className="sticky right-2 ml-auto flex shrink-0 gap-1 pl-4 font-sans not-italic">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          onClick={() => onHunk(index, action)}
          className={cn(
            "rounded border px-1.5 text-[11px] leading-5 transition-colors duration-150",
            action === "discard" || action === "revert"
              ? "border-line text-ink-3 hover:border-del/60 hover:text-del"
              : "border-line text-ink-2 hover:border-amber/60 hover:text-amber",
          )}
        >
          {HUNK_LABEL[action]}
        </button>
      ))}
    </span>
  );
};

/** Hoja sobre el área de terminales: diff de un archivo o vista previa. Esc cierra. */
export const Viewer: React.FC = () => {
  const viewer = useProjectStore((s) => s.viewer);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const target = viewer ? (viewer.kind === "diff" ? viewer.source : `${viewer.kind}:${viewer.path}`) : null;
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
      className="absolute inset-0 z-30 flex animate-fade-in flex-col bg-canvas"
    >
      {viewer.kind === "diff" && <DiffView viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "file" && <FileView viewer={viewer} bodyRef={bodyRef} />}
      {viewer.kind === "conflict" && <ConflictView key={viewer.path} viewer={viewer} bodyRef={bodyRef} />}
    </div>
  );
};

/* ------------------------------------------------------------------ */

const Header: React.FC<{ path: string; badge: string; badgeTone?: "amber"; children?: React.ReactNode }> = ({
  path,
  badge,
  badgeTone,
  children,
}) => {
  const { name, dir } = splitPath(path);
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-chrome pl-3 pr-1.5">
      <FileText size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="flex min-w-0 items-baseline gap-2 font-mono">
        <span className="shrink-0 text-[12.5px] text-ink">{name}</span>
        <span className="min-w-0 truncate text-[11px] text-ink-3">{dir}</span>
      </span>
      <span
        className={cn(
          "shrink-0 rounded-sm border px-1.5 font-mono text-[11px] leading-5",
          badgeTone === "amber" ? "border-amber/50 text-amber" : "border-line text-ink-3",
        )}
      >
        {badge}
      </span>
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
  const badge =
    viewer.source.kind === "commit"
      ? `Commit ${viewer.source.short}`
      : viewer.source.kind === "review"
        ? `Agente · ${viewer.source.label}`
        : SOURCE_LABEL[viewer.source.kind];
  const actions = hunkActions(viewer.source);
  const onHunk: OnHunk =
    parsed && actions.length
      ? (index, action) => {
          const patch = hunkPatch(parsed, index);
          if (patch) confirmHunk(action, patch);
        }
      : null;

  const switchMode = (next: Mode) => {
    setMode(next);
    saveMode(next);
  };

  const rows = useMemo(() => (parsed ? (showAll ? parsed.rows : parsed.rows.slice(0, ROW_CAP)) : []), [parsed, showAll]);
  const hidden = parsed ? parsed.rows.length - rows.length : 0;
  const highlighter = useHighlighter(viewer.source.path);
  // Línea a línea: barato y suficiente para un diff (un comentario de varias líneas puede colorearse a medias).
  const painted = useMemo(() => {
    const map = new Map<DiffRow, Segment[]>();
    if (!highlighter) return map;
    for (const row of rows.slice(0, HIGHLIGHT_ROWS)) {
      if (row.kind !== "add" && row.kind !== "del" && row.kind !== "context") continue;
      const line = highlighter(row.text)?.[0];
      if (line) map.set(row, line);
    }
    return map;
  }, [highlighter, rows]);

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
        {parsed &&
          rows.length > 0 &&
          (mode === "unified" ? (
            <UnifiedRows rows={rows} painted={painted} actions={actions} onHunk={onHunk} />
          ) : (
            <SplitRows rows={rows} painted={painted} actions={actions} onHunk={onHunk} />
          ))}
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

/** Segmentos coloreados (texto plano: React lo escapa). */
const Segments: React.FC<{ segments: Segment[] }> = ({ segments }) => (
  <>
    {segments.map((s, i) =>
      s.cls ? (
        <span key={i} className={s.cls}>
          {s.text}
        </span>
      ) : (
        <React.Fragment key={i}>{s.text}</React.Fragment>
      ),
    )}
  </>
);

/** Los segmentos que caen en [from, to) de la línea. */
function sliceSegments(segments: Segment[], from: number, to: number): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const s of segments) {
    const end = pos + s.text.length;
    const a = Math.max(from, pos);
    const b = Math.min(to, end);
    if (a < b) out.push({ ...s, text: s.text.slice(a - pos, b - pos) });
    pos = end;
    if (pos >= to) break;
  }
  return out;
}

/** Texto (coloreado si se puede) con el tramo cambiado resaltado. */
const Code: React.FC<{ row: DiffRow; segments?: Segment[] }> = ({ row, segments }) => {
  const paint = (from: number, to: number) =>
    segments ? <Segments segments={sliceSegments(segments, from, to)} /> : row.text.slice(from, to);
  if (!row.text) return <> </>;
  if (!row.changed) return <>{paint(0, row.text.length)}</>;
  const [start, end] = row.changed;
  const mark = row.kind === "add" ? "bg-add/30" : "bg-del/30";
  return (
    <>
      {paint(0, start)}
      <mark className={cn("rounded-[2px] text-inherit", mark)}>{paint(start, end)}</mark>
      {paint(end, row.text.length)}
    </>
  );
};

const SIGN: Partial<Record<DiffRow["kind"], string>> = { add: "+", del: "−" };

type Painted = Map<DiffRow, Segment[]>;

const UnifiedRows: React.FC<{ rows: DiffRow[]; painted: Painted; actions: HunkAction[]; onHunk: OnHunk }> = ({
  rows,
  painted,
  actions,
  onHunk,
}) => (
  <div className="w-max min-w-full pb-6">
    {rows.map((row, i) =>
      row.kind === "hunk" || row.kind === "meta" ? (
        <div key={i} className={cn("flex min-w-full items-center px-4 py-0.5", ROW_BG[row.kind], row.kind === "hunk" && "mt-2 first:mt-0")}>
          <span className="whitespace-pre text-[11.5px]">{row.kind === "hunk" ? `@@ ${row.text}` : row.text}</span>
          {row.kind === "hunk" && <HunkButtons index={row.hunk} actions={actions} onHunk={onHunk} />}
        </div>
      ) : (
        <div key={i} className={cn("flex min-w-full", ROW_BG[row.kind])}>
          <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", GUTTER_BG[row.kind])}>{row.oldNo ?? ""}</span>
          <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", GUTTER_BG[row.kind])}>{row.newNo ?? ""}</span>
          <span className={cn("w-6 shrink-0 select-none text-center", row.kind === "add" ? "text-add" : "text-del")}>{SIGN[row.kind] ?? ""}</span>
          <span className="whitespace-pre pr-6 text-ink">
            <Code row={row} segments={painted.get(row)} />
          </span>
        </div>
      ),
    )}
  </div>
);

const SplitCell: React.FC<{ row?: DiffRow; side: "left" | "right"; painted: Painted }> = ({ row, side, painted }) => {
  const no = side === "left" ? row?.oldNo : row?.newNo;
  const kind = row?.kind ?? "context";
  return (
    <div className={cn("flex min-w-0 flex-1", row ? ROW_BG[kind] : "bg-raised/40")}>
      <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", row ? GUTTER_BG[kind] : "")}>{no ?? ""}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 text-ink">
        {row && <Code row={row} segments={painted.get(row)} />}
      </span>
    </div>
  );
};

const SplitRows: React.FC<{ rows: DiffRow[]; painted: Painted; actions: HunkAction[]; onHunk: OnHunk }> = ({
  rows,
  painted,
  actions,
  onHunk,
}) => {
  const split = useMemo(() => toSplitRows(rows), [rows]);
  return (
    <div className="min-w-full pb-6">
      {split.map((r, i) =>
        r.full ? (
          <div
            key={i}
            className={cn("flex items-center px-4 py-0.5 whitespace-pre text-[11.5px]", ROW_BG[r.full.kind], r.full.kind === "hunk" && "mt-2 first:mt-0")}
          >
            {r.full.kind === "hunk" ? `@@ ${r.full.text}` : r.full.text}
            {r.full.kind === "hunk" && <HunkButtons index={r.full.hunk} actions={actions} onHunk={onHunk} />}
          </div>
        ) : (
          <div key={i} className="flex">
            <SplitCell row={r.left} side="left" painted={painted} />
            <span className="w-px shrink-0 bg-line" aria-hidden="true" />
            <SplitCell row={r.right} side="right" painted={painted} />
          </div>
        ),
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Archivo                                                             */
/* ------------------------------------------------------------------ */

/** Acciones comunes de un archivo: tu editor, pegar/copiar la ruta, Finder. */
const FileActions: React.FC<{ path: string; absolute: string | null; line?: number }> = ({ path, absolute, line }) => {
  const toast = useUiStore((s) => s.showToast);
  if (!absolute) return null;
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      toast("Ruta copiada.");
    } catch {
      toast("No se pudo copiar la ruta.", "error");
    }
  };
  return (
    <>
      <IconButton icon={SquarePen} label="Abrir en tu editor (Cursor, VS Code…)" size="sm" onClick={() => void openInEditor(path, line)} />
      <IconButton icon={CornerDownLeft} label="Pegar la ruta en la terminal" size="sm" onClick={() => pastePath(absolute)} />
      <IconButton icon={Copy} label="Copiar ruta" size="sm" onClick={() => void copyPath()} />
      {IS_TAURI && (
        <IconButton
          icon={FolderOpen}
          label="Mostrar en Finder"
          size="sm"
          onClick={() => void revealItemInDir(absolute).catch(() => toast("No se pudo abrir Finder.", "error"))}
        />
      )}
    </>
  );
};

const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

const FileView: React.FC<{
  viewer: Extract<ViewerState, { kind: "file" }>;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, bodyRef }) => {
  if (viewer.image) return <ImageFile viewer={viewer} image={viewer.image} bodyRef={bodyRef} />;
  if (viewer.preview && !viewer.preview.binary) {
    return <TextFile key={viewer.path} viewer={viewer} preview={viewer.preview} bodyRef={bodyRef} />;
  }
  return (
    <>
      <Header path={viewer.path} badge={viewer.preview ? formatBytes(viewer.preview.size) : "Archivo"}>
        <FileActions path={viewer.path} absolute={viewer.preview?.absolute ?? absolutePath(viewer.path)} />
      </Header>
      <Body bodyRef={bodyRef}>
        {viewer.error && <Notice tone="error">{viewer.error}</Notice>}
        {!viewer.error && !viewer.preview && <Notice>Abriendo…</Notice>}
        {viewer.preview?.binary && <Notice>Archivo binario: no se puede mostrar aquí. Ábrelo con su aplicación desde Finder.</Notice>}
      </Body>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Imagen                                                              */
/* ------------------------------------------------------------------ */

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

const ImageFile: React.FC<{
  viewer: Extract<ViewerState, { kind: "file" }>;
  image: { url: string; bytes: number };
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, image, bodyRef }) => {
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // La imagen llega después de abrir el visor: el foco vuelve aquí para que
  // Esc y +/− funcionen sin hacer clic.
  useEffect(() => {
    bodyRef.current?.focus();
  }, [bodyRef, image.url]);

  /** Escala real que se ve ahora (para saber desde dónde acercar o alejar). */
  const currentScale = () => {
    if (zoom !== "fit") return zoom;
    const img = imgRef.current;
    return img && natural?.w ? img.clientWidth / natural.w : 1;
  };
  const step = (dir: 1 | -1) => {
    const scale = currentScale();
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > scale + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001);
    setZoom(next ?? (dir > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0]));
  };
  const label = zoom === "fit" ? "Ajustada" : `${Math.round(zoom * 100)} %`;
  const isSvg = viewer.path.toLowerCase().endsWith(".svg");

  return (
    <>
      <Header
        path={viewer.path}
        badge={[natural?.w ? `${natural.w}×${natural.h}` : isSvg ? "SVG" : null, formatBytes(image.bytes)].filter(Boolean).join(" · ")}
      >
        <span className="flex items-center gap-0.5 font-sans text-[12px]">
          <IconButton icon={Minus} label="Alejar" shortcut="−" size="sm" onClick={() => step(-1)} />
          <button
            type="button"
            onClick={() => setZoom(zoom === "fit" ? 1 : "fit")}
            title={zoom === "fit" ? "Tamaño real (1)" : "Ajustar a la ventana (0)"}
            className="w-[74px] rounded px-1.5 text-center font-mono text-[11.5px] tabular-nums text-ink-2 hover:bg-hover"
          >
            {label}
          </button>
          <IconButton icon={Plus} label="Acercar" shortcut="+" size="sm" onClick={() => step(1)} />
        </span>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        <FileActions path={viewer.path} absolute={absolutePath(viewer.path)} />
      </Header>
      <div
        ref={bodyRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "+" || e.key === "=") step(1);
          else if (e.key === "-" || e.key === "_") step(-1);
          else if (e.key === "0") setZoom("fit");
          else if (e.key === "1") setZoom(1);
          else return;
          e.preventDefault();
        }}
        className="checkerboard grid min-h-0 flex-1 place-items-center overflow-auto p-6 outline-none"
      >
        {failed ? (
          <Notice tone="error">El visor no pudo dibujar esta imagen (¿formato no soportado por el sistema?).</Notice>
        ) : (
          <img
            ref={imgRef}
            src={image.url}
            alt={viewer.path}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            style={zoom === "fit" || !natural?.w ? undefined : { width: natural.w * zoom, maxWidth: "none", maxHeight: "none" }}
            className={cn(
              "select-none shadow-[0_8px_32px_-8px_rgb(0_0_0/0.5)]",
              zoom === "fit" && "max-h-full max-w-full object-contain",
              // Pixel art y capturas pequeñas: sin difuminar al ampliar.
              zoom !== "fit" && zoom > 1 && "[image-rendering:pixelated]",
            )}
          />
        )}
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Texto: editor                                                       */
/* ------------------------------------------------------------------ */

type EditorModule = typeof import("../../editor/codemirror");
type EditorHandle = ReturnType<EditorModule["createEditor"]>;

const TextFile: React.FC<{
  viewer: Extract<ViewerState, { kind: "file" }>;
  preview: FilePreview;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, preview, bodyRef }) => {
  const path = viewer.path;
  const editable = preview.utf8 && !preview.truncated;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const busyRef = useRef(false);
  // Solo el contenido con el que se abrió: el componente se monta de nuevo por archivo.
  const initial = useRef({ text: preview.text, line: viewer.line, readOnly: !editable });
  const saveRef = useRef<(force?: boolean) => void>(() => {});
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // El editor se crea una vez por archivo (CodeMirror llega bajo demanda).
  useEffect(() => {
    let disposed = false;
    import("../../editor/codemirror")
      .then(({ createEditor }) => {
        if (disposed || !hostRef.current) return;
        const handle = createEditor(hostRef.current, {
          doc: initial.current.text,
          path,
          readOnly: initial.current.readOnly,
          line: initial.current.line,
          onDirtyChange: (next) => {
            setDirty(next);
            notifyUnsaved(next);
          },
          onSave: () => saveRef.current(),
        });
        editorRef.current = handle;
        registerUnsaved({ path, isDirty: handle.isDirty });
        setReady(true);
        handle.focus();
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      disposed = true;
      editorRef.current?.destroy();
      editorRef.current = null;
      registerUnsaved(null);
      notifyUnsaved(false);
    };
  }, [path]);

  // ⌘-clic en otra línea del mismo archivo: solo se salta.
  useEffect(() => {
    if (ready && viewer.line) editorRef.current?.goToLine(viewer.line);
  }, [ready, viewer.line]);

  const save = async (force = false) => {
    const editor = editorRef.current;
    if (!editor || !editable || busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    const snapshot = editor.snapshot();
    const result = await saveFile(path, snapshot.text, force);
    busyRef.current = false;
    setSaving(false);
    if (result === "saved") {
      editor.markSaved(snapshot);
      setDiskChanged(false);
      setSavedAt(Date.now());
    } else if (result === "conflict") {
      setDiskChanged(true);
    }
  };
  useEffect(() => {
    saveRef.current = (force) => void save(force);
  });

  const reload = async () => {
    const text = await reloadFile(path);
    if (text !== null) {
      editorRef.current?.replaceText(text);
      setDiskChanged(false);
    }
  };

  // Un agente (u otra app) cambió el archivo: si no hay cambios tuyos se recarga
  // solo; si los hay, se avisa y tú decides.
  useEffect(() => {
    if (!ready) return;
    const check = async () => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      const changed = await fileChangedOnDisk(path);
      const editor = editorRef.current;
      if (!changed || !editor || busyRef.current) return;
      if (editor.isDirty()) {
        setDiskChanged(true);
        return;
      }
      const text = await reloadFile(path);
      if (text !== null && !editor.isDirty()) editor.replaceText(text);
    };
    const timer = setInterval(() => void check(), 2000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [ready, path]);

  // "Guardado" se ve un momento y se va.
  useEffect(() => {
    if (!savedAt) return;
    const timer = setTimeout(() => setSavedAt(null), 1600);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const badge = !editable
    ? "Solo lectura"
    : dirty
      ? "● Sin guardar"
      : savedAt
        ? "Guardado"
        : formatBytes(preview.size);

  return (
    <>
      <Header path={path} badge={badge} badgeTone={dirty ? "amber" : undefined}>
        {editable && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            title="Guardar  ⌘S"
            className="flex h-7 items-center gap-1.5 rounded-md bg-amber px-2.5 font-sans text-[12px] font-medium text-on-amber transition-opacity duration-150 disabled:opacity-0"
          >
            <Check size={13} strokeWidth={2} aria-hidden="true" />
            {saving ? "Guardando…" : "Guardar"}
            <Kbd className="text-on-amber/70">⌘S</Kbd>
          </button>
        )}
        <FileActions path={path} absolute={preview.absolute} line={viewer.line} />
      </Header>
      {diskChanged && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber/40 bg-amber/[0.08] px-4 py-2 text-[12.5px]">
          <span className="text-ink">El archivo cambió en disco mientras lo editabas (¿un agente?).</span>
          <span className="flex-1" />
          <button type="button" onClick={() => void reload()} className="rounded border border-line px-2 leading-6 text-ink-2 hover:bg-hover">
            Recargar (pierdes tus cambios)
          </button>
          <button type="button" onClick={() => void save(true)} className="rounded bg-amber px-2 leading-6 font-medium text-on-amber hover:opacity-90">
            Sobrescribir con lo mío
          </button>
        </div>
      )}
      {!editable && (
        <p className="shrink-0 border-b border-line bg-raised px-4 py-1.5 text-[12px] text-ink-3">
          {preview.truncated
            ? "Archivo de más de 2 MB: aquí solo ves el principio y no se puede editar. Ábrelo en tu editor."
            : "No está en UTF-8: editarlo aquí lo dañaría. Ábrelo en tu editor."}
        </p>
      )}
      {loadError && <Notice tone="error">No se pudo cargar el editor: {loadError}</Notice>}
      <div ref={bodyRef} tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
        <div ref={hostRef} className="absolute inset-0" />
        {!ready && !loadError && <p className="absolute left-4 top-4 font-sans text-[13px] text-ink-3">Abriendo…</p>}
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Conflictos                                                          */
/* ------------------------------------------------------------------ */

const CHOICE_LABEL: Record<Choice, string> = { ours: "Aceptar actual", theirs: "Aceptar entrante", both: "Ambos" };

const ConflictView: React.FC<{
  viewer: Extract<ViewerState, { kind: "conflict" }>;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}> = ({ viewer, bodyRef }) => {
  const chunks = useMemo(() => (viewer.text === undefined ? null : parseConflicts(viewer.text)), [viewer.text]);
  const [choices, setChoices] = useState<Array<Choice | undefined>>([]);
  const busy = useProjectStore((s) => s.busy === "resolve");
  const highlighter = useHighlighter(viewer.path);
  const total = chunks ? conflictCount(chunks) : 0;
  const decided = choices.filter(Boolean).length;
  const result = chunks && decided >= total ? resolveConflicts(chunks, choices) : null;

  const choose = (index: number, choice: Choice) =>
    setChoices((current) => {
      const next = [...current];
      next[index] = choice;
      return next;
    });

  let conflictIndex = 0;
  return (
    <>
      <Header path={viewer.path} badge={chunks ? (total ? `${decided}/${total} conflictos` : "Sin marcas") : "Conflicto"}>
        {total > 1 && (
          <>
            <TextAction onClick={() => setChoices(Array<Choice>(total).fill("ours"))}>Todo lo actual</TextAction>
            <TextAction onClick={() => setChoices(Array<Choice>(total).fill("theirs"))}>Todo lo entrante</TextAction>
          </>
        )}
        <IconButton icon={SquarePen} label="Abrir en el editor" size="sm" onClick={() => void openInEditor(viewer.path)} />
        <button
          type="button"
          disabled={result === null || busy}
          onClick={() => result !== null && void saveConflict(viewer.path, result)}
          className="ml-1 flex h-7 items-center gap-1.5 rounded-md bg-amber px-2.5 font-sans text-[12px] font-medium text-on-amber transition-opacity duration-150 disabled:opacity-40"
        >
          <Check size={13} strokeWidth={2} aria-hidden="true" />
          {busy ? "Guardando…" : "Guardar y marcar resuelto"}
        </button>
      </Header>
      <Body bodyRef={bodyRef}>
        {viewer.error && <Notice tone="error">{viewer.error}</Notice>}
        {!viewer.error && !chunks && <Notice>Abriendo…</Notice>}
        {chunks && total === 0 && (
          <Notice>
            El archivo ya no tiene marcas de conflicto (¿lo editaste a mano?). Revísalo y márcalo como resuelto, o ábrelo en tu
            editor.
          </Notice>
        )}
        {chunks && (
          <div className="w-max min-w-full py-2 pb-10">
            {chunks.map((chunk, i) =>
              chunk.kind === "text" ? (
                <ContextLines key={i} lines={chunk.lines} highlighter={highlighter} first={i === 0} last={i === chunks.length - 1} />
              ) : (
                (() => {
                  const index = conflictIndex++;
                  return (
                    <ConflictBlock
                      key={i}
                      chunk={chunk}
                      index={index}
                      choice={choices[index]}
                      onChoose={(c) => choose(index, c)}
                      highlighter={highlighter}
                    />
                  );
                })()
              ),
            )}
          </div>
        )}
      </Body>
    </>
  );
};

const TextAction: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button type="button" onClick={onClick} className="rounded px-1.5 font-sans text-[12px] text-ink-3 hover:bg-hover hover:text-ink-2">
    {children}
  </button>
);

/** Contexto entre conflictos: largo → solo los bordes, expandible. */
const ContextLines: React.FC<{
  lines: string[];
  highlighter: ReturnType<typeof useHighlighter>;
  first: boolean;
  last: boolean;
}> = ({ lines, highlighter, first, last }) => {
  const [open, setOpen] = useState(false);
  const painted = useMemo(() => highlighter?.(lines.join("\n")) ?? null, [highlighter, lines]);
  const EDGE = 3;
  const collapsible = !open && lines.length > EDGE * 2 + 2;
  const head = collapsible ? (first ? 0 : EDGE) : lines.length;
  const tail = collapsible ? (last ? 0 : EDGE) : 0;
  const render = (from: number, to: number) =>
    lines.slice(from, to).map((line, k) => {
      const segments = painted?.[from + k];
      return (
        <div key={from + k} className="whitespace-pre px-4 text-ink-2">
          {segments ? segments.length ? <Segments segments={segments} /> : " " : line || " "}
        </div>
      );
    });
  if (!collapsible) return <>{render(0, lines.length)}</>;
  return (
    <>
      {render(0, head)}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-1 ml-4 rounded border border-line px-2 font-sans text-[11px] leading-5 text-ink-3 hover:bg-hover hover:text-ink-2"
      >
        ⋯ {lines.length - head - tail} líneas sin conflicto
      </button>
      {render(lines.length - tail, lines.length)}
    </>
  );
};

const ConflictBlock: React.FC<{
  chunk: Extract<ConflictChunk, { kind: "conflict" }>;
  index: number;
  choice?: Choice;
  onChoose: (choice: Choice) => void;
  highlighter: ReturnType<typeof useHighlighter>;
}> = ({ chunk, index, choice, onChoose, highlighter }) => {
  const keepsOurs = choice === "ours" || choice === "both";
  const keepsTheirs = choice === "theirs" || choice === "both";
  return (
    <section
      aria-label={`Conflicto ${index + 1}`}
      className={cn(
        "mx-4 my-3 min-w-[min(720px,100%)] overflow-hidden rounded-md border font-mono",
        choice ? "border-line" : "border-amber/60",
      )}
    >
      <ConflictSide
        title={`Actual · ${chunk.oursLabel || "HEAD"}`}
        lines={chunk.ours}
        tone="ours"
        dimmed={Boolean(choice) && !keepsOurs}
        highlighter={highlighter}
      />
      {chunk.base && (
        <details className="border-t border-line bg-raised/40">
          <summary className="cursor-pointer px-3 py-1 font-sans text-[11px] text-ink-3 hover:text-ink-2">Ver el original</summary>
          {chunk.base.map((line, k) => (
            <div key={k} className="whitespace-pre px-3 text-ink-3">
              {line || " "}
            </div>
          ))}
        </details>
      )}
      <ConflictSide
        title={`Entrante · ${chunk.theirsLabel || "otra rama"}`}
        lines={chunk.theirs}
        tone="theirs"
        dimmed={Boolean(choice) && !keepsTheirs}
        highlighter={highlighter}
      />
      <div className="flex items-center gap-1.5 border-t border-line bg-chrome px-3 py-1.5 font-sans">
        {(["ours", "theirs", "both"] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={choice === c}
            onClick={() => onChoose(c)}
            className={cn(
              "rounded border px-2 text-[11.5px] leading-6 transition-colors duration-150",
              choice === c ? "border-amber bg-amber text-on-amber" : "border-line text-ink-2 hover:border-amber/60 hover:text-amber",
            )}
          >
            {CHOICE_LABEL[c]}
          </button>
        ))}
        {!choice && <span className="ml-2 text-[11px] text-ink-3">Elige qué se queda</span>}
      </div>
    </section>
  );
};

const ConflictSide: React.FC<{
  title: string;
  lines: string[];
  tone: "ours" | "theirs";
  dimmed: boolean;
  highlighter: ReturnType<typeof useHighlighter>;
}> = ({ title, lines, tone, dimmed, highlighter }) => {
  const painted = useMemo(() => (lines.length ? (highlighter?.(lines.join("\n")) ?? null) : null), [highlighter, lines]);
  return (
    <div className={cn("transition-opacity duration-150", dimmed && "opacity-35", tone === "theirs" && "border-t border-line")}>
      <div
        className={cn(
          "flex items-center gap-1.5 px-3 py-1 font-sans text-[11px]",
          tone === "ours" ? "bg-amber/10 text-amber" : "bg-hover text-ink-2",
        )}
      >
        <GitMerge size={11} aria-hidden="true" />
        {title}
      </div>
      <div className={tone === "ours" ? "bg-amber/[0.04]" : undefined}>
        {lines.length === 0 && <div className="px-3 font-sans text-[11.5px] italic text-ink-3">(nada: este lado borró el bloque)</div>}
        {lines.map((line, k) => {
          const segments = painted?.[k];
          return (
            <div key={k} className={cn("whitespace-pre px-3 text-ink", dimmed && "line-through decoration-ink-3/60")}>
              {segments ? segments.length ? <Segments segments={segments} /> : " " : line || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
};
