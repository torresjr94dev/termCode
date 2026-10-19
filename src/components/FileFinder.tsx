import React, { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";
import { useUiStore } from "../store/uiStore";
import { useProjectStore } from "../store/projectStore";
import { openFile, openInEditor, projectFiles, projectRoot } from "../lib/project";
import { fuzzyFilter } from "../lib/fuzzy";
import { cn } from "../lib/layout";
import { IS_MAC } from "../lib/shortcuts";
import { Kbd } from "./ui";

const LIMIT = 60;

export const FileFinder: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const isOpen = useUiStore((s) => s.isFinderOpen);
  if (!isOpen) return null;
  return <FinderPanel onClosed={onClosed} />;
};

/** Texto con las letras coincidentes resaltadas. */
const Highlighted: React.FC<{ text: string; positions: Set<number>; offset: number; className?: string }> = ({
  text,
  positions,
  offset,
  className,
}) => (
  <span className={className}>
    {Array.from(text, (ch, i) =>
      positions.has(i + offset) ? (
        <b key={i} className="font-semibold text-amber">
          {ch}
        </b>
      ) : (
        ch
      ),
    )}
  </span>
);

const FinderPanel: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const setOpen = useUiStore((s) => s.setFinderOpen);
  const cwd = useProjectStore((s) => s.cwd);
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const root = projectRoot();

  useEffect(() => {
    inputRef.current?.focus();
    let alive = true;
    projectFiles()
      .then((list) => alive && setFiles(list))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const results = useMemo(() => {
    if (!files) return [];
    if (!query.trim()) return files.slice(0, LIMIT).map((item) => ({ item, score: 0, positions: [] as number[] }));
    return fuzzyFilter(files, query, (f) => f, LIMIT);
  }, [files, query]);

  const selected = Math.min(cursor, Math.max(results.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = () => {
    setOpen(false);
    onClosed();
  };

  const pick = (path: string, inEditor: boolean) => {
    setOpen(false);
    if (inEditor) {
      void openInEditor(path);
      onClosed();
    } else {
      void openFile(path);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/60 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Buscar archivo"
        className="flex max-h-[70vh] w-full max-w-[640px] animate-pop-in flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)]"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
                e.preventDefault();
                setCursor(Math.min(selected + 1, results.length - 1));
              } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
                e.preventDefault();
                setCursor(Math.max(selected - 1, 0));
              } else if (e.key === "Enter" && results[selected]) {
                e.preventDefault();
                pick(results[selected].item, e.metaKey || e.ctrlKey);
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="finder-results"
            aria-activedescendant={results[selected] ? `finder-${selected}` : undefined}
            placeholder={root ? `Buscar en ${root.split("/").pop()}…` : "Abre una carpeta en la terminal"}
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3"
          />
          {files && <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{files.length.toLocaleString("es-MX")}</span>}
        </div>

        <ul ref={listRef} id="finder-results" role="listbox" aria-label="Archivos" className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {error && <li className="px-4 py-6 text-[12.5px] text-signal">{error}</li>}
          {!error && !files && <li className="px-4 py-6 text-[12.5px] text-ink-3">Indexando archivos…</li>}
          {files && !results.length && <li className="px-4 py-6 text-[12.5px] text-ink-3">Ningún archivo coincide.</li>}
          {results.map((r, i) => {
            const slash = r.item.lastIndexOf("/");
            const name = r.item.slice(slash + 1);
            const dir = slash >= 0 ? r.item.slice(0, slash) : "";
            const positions = new Set(r.positions);
            return (
              <li
                key={r.item}
                id={`finder-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => i !== selected && setCursor(i)}
                onClick={(e) => pick(r.item, e.metaKey || e.ctrlKey)}
                className={cn(
                  "mx-1.5 flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5",
                  i === selected ? "bg-press text-ink" : "text-ink-2",
                )}
              >
                <FileText size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
                <Highlighted text={name} positions={positions} offset={slash + 1} className="shrink-0 font-mono text-[12.5px]" />
                <Highlighted text={dir} positions={positions} offset={0} className="min-w-0 truncate font-mono text-[11.5px] text-ink-3" />
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-4 border-t border-line bg-chrome px-3.5 py-2 text-[11.5px] text-ink-3">
          <span>
            <Kbd>↵</Kbd> ver
          </span>
          <span>
            <Kbd>{IS_MAC ? "⌘↵" : "Ctrl+↵"}</Kbd> abrir en el editor
          </span>
          <span className="ml-auto">
            <Kbd>esc</Kbd>
          </span>
        </div>
      </div>
    </div>
  );
};
