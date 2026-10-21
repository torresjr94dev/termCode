import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Columns2, Rows3 } from "lucide-react";
import { sameSource, type DiffSource, type Viewer as ViewerState } from "../../../store/projectStore";
import { confirmHunk, hunkActions, stepDiff, type HunkAction } from "../../../lib/project";
import { hunkPatch, parseUnifiedDiff, toSplitRows, type DiffRow } from "../../../lib/diff";
import { useHighlighter, type Segment } from "../../../lib/highlight";
import { cn } from "../../../lib/layout";
import { IconButton } from "../../ui";
import { Body, Header, Notice, Segments } from "./parts";
import { CommentButton, LineThread, rowAnchor, SendReviewButton, useComments, type Comments } from "./Comments";
import { altLabel } from "../../../lib/shortcuts";

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
              : "border-line text-ink-2 hover:border-accent/60 hover:text-accent",
          )}
        >
          {HUNK_LABEL[action]}
        </button>
      ))}
    </span>
  );
};

export const DiffView: React.FC<{
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
  const comments = useComments(viewer.source);
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
            <IconButton icon={ChevronUp} label="Archivo anterior" shortcut={altLabel("↑")} size="sm" disabled={index <= 0} onClick={() => stepDiff(-1)} />
            <span className="w-10 text-center font-mono text-[11px] tabular-nums text-ink-3">
              {index + 1}/{viewer.siblings.length}
            </span>
            <IconButton
              icon={ChevronDown}
              label="Archivo siguiente"
              shortcut={altLabel("↓")}
              size="sm"
              disabled={index >= viewer.siblings.length - 1}
              onClick={() => stepDiff(1)}
            />
          </span>
        )}
        <SendReviewButton pending={comments.pending} />
      </Header>
      <Body bodyRef={bodyRef}>
        {viewer.error && <Notice tone="error">{viewer.error}</Notice>}
        {!viewer.error && !parsed && <Notice>Calculando diff…</Notice>}
        {parsed?.binary && <Notice>Archivo binario: no hay diff de texto que mostrar.</Notice>}
        {parsed && !parsed.binary && !parsed.rows.length && <Notice>Sin diferencias de contenido (¿solo permisos?).</Notice>}
        {parsed &&
          rows.length > 0 &&
          (mode === "unified" ? (
            <UnifiedRows rows={rows} painted={painted} actions={actions} onHunk={onHunk} comments={comments} />
          ) : (
            <SplitRows rows={rows} painted={painted} actions={actions} onHunk={onHunk} comments={comments} />
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

interface RowsProps {
  rows: DiffRow[];
  painted: Painted;
  actions: HunkAction[];
  onHunk: OnHunk;
  comments: Comments;
}

const UnifiedRows: React.FC<RowsProps> = ({ rows, painted, actions, onHunk, comments }) => (
  <div className="w-max min-w-full pb-6">
    {rows.map((row, i) =>
      row.kind === "hunk" || row.kind === "meta" ? (
        <div key={i} className={cn("flex min-w-full items-center px-4 py-0.5", ROW_BG[row.kind], row.kind === "hunk" && "mt-2 first:mt-0")}>
          <span className="whitespace-pre text-[11.5px]">{row.kind === "hunk" ? `@@ ${row.text}` : row.text}</span>
          {row.kind === "hunk" && <HunkButtons index={row.hunk} actions={actions} onHunk={onHunk} />}
        </div>
      ) : (
        <UnifiedLine key={i} row={row} segments={painted.get(row)} comments={comments} />
      ),
    )}
  </div>
);

const UnifiedLine: React.FC<{ row: DiffRow; segments?: Segment[]; comments: Comments }> = ({ row, segments, comments }) => {
  const anchor = rowAnchor(row);
  return (
    <>
      <div className={cn("group relative flex min-w-full", ROW_BG[row.kind])}>
        {anchor && <CommentButton comments={comments} side={anchor.side} line={anchor.line} />}
        <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", GUTTER_BG[row.kind])}>{row.oldNo ?? ""}</span>
        <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", GUTTER_BG[row.kind])}>{row.newNo ?? ""}</span>
        <span className={cn("w-6 shrink-0 select-none text-center", row.kind === "add" ? "text-add" : "text-del")}>{SIGN[row.kind] ?? ""}</span>
        <span className="whitespace-pre pr-6 text-ink">
          <Code row={row} segments={segments} />
        </span>
      </div>
      {anchor && <LineThread comments={comments} side={anchor.side} line={anchor.line} quote={row.text} />}
    </>
  );
};

/** Lado a lado: a la izquierda solo se comentan las líneas borradas (el contexto se comenta a la derecha). */
const cellAnchor = (row: DiffRow | undefined, side: "left" | "right") =>
  !row ? null : side === "left" ? (row.kind === "del" ? rowAnchor(row, "old") : null) : rowAnchor(row, "new");

const SplitCell: React.FC<{ row?: DiffRow; side: "left" | "right"; painted: Painted; comments: Comments }> = ({ row, side, painted, comments }) => {
  const no = side === "left" ? row?.oldNo : row?.newNo;
  const kind = row?.kind ?? "context";
  const anchor = cellAnchor(row, side);
  return (
    <div className={cn("group relative flex min-w-0 flex-1", row ? ROW_BG[kind] : "bg-raised/40")}>
      {anchor && <CommentButton comments={comments} side={anchor.side} line={anchor.line} />}
      <span className={cn("w-12 shrink-0 select-none pr-2 text-right tabular-nums", row ? GUTTER_BG[kind] : "")}>{no ?? ""}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 text-ink">
        {row && <Code row={row} segments={painted.get(row)} />}
      </span>
    </div>
  );
};

const SplitRows: React.FC<RowsProps> = ({ rows, painted, actions, onHunk, comments }) => {
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
          <React.Fragment key={i}>
            <div className="flex">
              <SplitCell row={r.left} side="left" painted={painted} comments={comments} />
              <span className="w-px shrink-0 bg-line" aria-hidden="true" />
              <SplitCell row={r.right} side="right" painted={painted} comments={comments} />
            </div>
            {[cellAnchor(r.left, "left"), cellAnchor(r.right, "right")].map(
              (anchor, k) =>
                anchor && (
                  <LineThread key={k} comments={comments} side={anchor.side} line={anchor.line} quote={(k === 0 ? r.left : r.right)?.text ?? ""} />
                ),
            )}
          </React.Fragment>
        ),
      )}
    </div>
  );
};
