import React, { useMemo, useState } from "react";
import { Check, GitMerge, SquarePen } from "lucide-react";
import { useProjectStore, type Viewer as ViewerState } from "../../../store/projectStore";
import { openInEditor, saveConflict } from "../../../lib/project";
import { useHighlighter } from "../../../lib/highlight";
import { conflictCount, parseConflicts, resolveConflicts, type Choice, type ConflictChunk } from "../../../lib/conflicts";
import { cn } from "../../../lib/layout";
import { IconButton } from "../../ui";
import { Body, Header, Notice, Segments } from "./parts";

const CHOICE_LABEL: Record<Choice, string> = { ours: "Aceptar actual", theirs: "Aceptar entrante", both: "Ambos" };

export const ConflictView: React.FC<{
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
          className="ml-1 flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 font-sans text-[12px] font-medium text-on-accent transition-opacity duration-150 disabled:opacity-40"
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
        choice ? "border-line" : "border-accent/60",
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
              choice === c ? "border-accent bg-accent text-on-accent" : "border-line text-ink-2 hover:border-accent/60 hover:text-accent",
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
          tone === "ours" ? "bg-accent/10 text-accent" : "bg-hover text-ink-2",
        )}
      >
        <GitMerge size={11} aria-hidden="true" />
        {title}
      </div>
      <div className={tone === "ours" ? "bg-accent/[0.04]" : undefined}>
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
