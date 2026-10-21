import React, { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, MessageSquarePlus, Send, Trash2 } from "lucide-react";
import { useProjectStore, type DiffSource } from "../../../store/projectStore";
import { addNote, removeNote, sendReview } from "../../../lib/project";
import { noteAnchor, type ReviewNote } from "../../../lib/reviewNotes";
import type { DiffRow } from "../../../lib/diff";
import { IS_MAC } from "../../../lib/shortcuts";
import { IconButton, Kbd } from "../../ui";

type Side = ReviewNote["side"];

/** A qué línea se ancla un comentario: borradas a su número viejo; el resto, al nuevo. */
export function rowAnchor(row: DiffRow, side?: Side): { side: Side; line: number } | null {
  const wanted = side ?? (row.kind === "del" ? "old" : "new");
  const line = wanted === "old" ? row.oldNo : row.newNo;
  if (row.kind !== "add" && row.kind !== "del" && row.kind !== "context") return null;
  return line === undefined ? null : { side: wanted, line };
}

export interface Comments {
  /** Comentarios de esta línea, o nada. */
  at: (side: Side, line: number) => ReviewNote[] | undefined;
  isComposing: (side: Side, line: number) => boolean;
  open: (side: Side, line: number) => void;
  close: () => void;
  save: (side: Side, line: number, quote: string, text: string) => void;
  /** Sin mandar en todo este árbol (todos los archivos de la revisión). */
  pending: number;
}

export function useComments(source: DiffSource): Comments {
  const repoRoot = useProjectStore((s) => s.repo?.root ?? null);
  const notes = useProjectStore((s) => s.notes);
  const root = source.root ?? repoRoot;
  // El borrador va atado al archivo: cambiar de archivo lo cierra sin efectos.
  const [composing, setComposing] = useState<{ path: string; anchor: string } | null>(null);

  const byAnchor = useMemo(() => {
    const map = new Map<string, ReviewNote[]>();
    for (const note of notes) {
      if (note.root !== root || note.path !== source.path) continue;
      const key = noteAnchor(note.side, note.line);
      map.set(key, [...(map.get(key) ?? []), note]);
    }
    return map;
  }, [notes, root, source.path]);
  const pending = useMemo(() => notes.filter((n) => n.root === root).length, [notes, root]);

  return {
    at: (side, line) => byAnchor.get(noteAnchor(side, line)),
    isComposing: (side, line) => composing?.path === source.path && composing.anchor === noteAnchor(side, line),
    open: (side, line) => setComposing({ path: source.path, anchor: noteAnchor(side, line) }),
    close: () => setComposing(null),
    save: (side, line, quote, text) => {
      if (root) addNote({ root, path: source.path, side, line, quote, text });
      setComposing(null);
    },
    pending,
  };
}

/** El «+» que aparece al pasar por una línea (como en un PR). */
export const CommentButton: React.FC<{ comments: Comments; side: Side; line: number; className?: string }> = ({
  comments,
  side,
  line,
  className,
}) => (
  <button
    type="button"
    aria-label={`Comentar la línea ${line}${side === "old" ? " (borrada)" : ""}`}
    title="Comentar esta línea para el agente"
    onClick={() => comments.open(side, line)}
    className={
      "absolute top-0 z-[1] grid h-5 w-5 place-items-center rounded text-accent opacity-0 transition-opacity duration-100 hover:bg-accent/15 focus-visible:opacity-100 group-hover:opacity-100 " +
      (className ?? "left-0.5")
    }
  >
    <MessageSquarePlus size={13} strokeWidth={1.75} aria-hidden="true" />
  </button>
);

/** Los comentarios de una línea y, si toca, el campo para escribir uno. */
export const LineThread: React.FC<{ comments: Comments; side: Side; line: number; quote: string }> = ({ comments, side, line, quote }) => {
  const notes = comments.at(side, line);
  const composing = comments.isComposing(side, line);
  if (!notes?.length && !composing) return null;
  return (
    <div className="sticky left-0 flex w-[min(720px,calc(100vw-48px))] flex-col gap-1.5 py-1.5 pl-[116px] pr-4 font-sans">
      {notes?.map((note) => (
        <div key={note.id} className="flex items-start gap-2 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px]">
          <MessageSquare size={12} strokeWidth={1.75} aria-hidden="true" className="mt-[3px] shrink-0 text-accent" />
          <p className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed text-ink">{note.text}</p>
          <IconButton size="sm" icon={Trash2} tone="danger" label="Quitar comentario" onClick={() => removeNote(note.id)} />
        </div>
      ))}
      {composing && <Composer onCancel={comments.close} onSave={(text) => comments.save(side, line, quote, text)} />}
    </div>
  );
};

const Composer: React.FC<{ onSave: (text: string) => void; onCancel: () => void }> = ({ onSave, onCancel }) => {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => text.trim() && onSave(text);
  return (
    <div className="rounded-md border border-accent/50 bg-raised p-2">
      <textarea
        ref={ref}
        value={text}
        rows={3}
        aria-label="Comentario para el agente"
        placeholder="Qué debe cambiar el agente aquí…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Esc cierra el comentario, no el visor.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        className="block w-full resize-y rounded border border-line bg-canvas px-2 py-1.5 text-[12.5px] leading-relaxed text-ink outline-none focus:border-line-strong"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="flex h-6 items-center gap-1.5 rounded px-2 text-[12px] text-ink-3 hover:bg-hover hover:text-ink">
          Cancelar <Kbd>esc</Kbd>
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          className="flex h-6 items-center gap-1.5 rounded bg-accent px-2 text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-40"
        >
          Comentar <Kbd className="text-on-accent/70">{IS_MAC ? "⌘↵" : "Ctrl+↵"}</Kbd>
        </button>
      </div>
    </div>
  );
};

/** «Enviar revisión (3)»: todos los comentarios del árbol, a su agente, en un mensaje. */
export const SendReviewButton: React.FC<{ pending: number }> = ({ pending }) =>
  pending ? (
    <button
      type="button"
      onClick={() => void sendReview()}
      title="Pega los comentarios en el agente (sin Enter: tú lo mandas)"
      className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 font-sans text-[12px] font-medium text-on-accent transition-opacity duration-150 hover:opacity-90"
    >
      <Send size={12} strokeWidth={2} aria-hidden="true" />
      Enviar revisión ({pending})
    </button>
  ) : null;
