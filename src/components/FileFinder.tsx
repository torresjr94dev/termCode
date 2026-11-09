import React, { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, FileText, Folder, FolderSearch, History, Regex, Search, TextSearch, WholeWord, X } from "lucide-react";
import { useUiStore, type FinderMode, type FinderRequest } from "../store/uiStore";
import { useProjectStore } from "../store/projectStore";
import { absolutePath, openFile, openInEditor, projectFiles, projectRoot, recentFiles } from "../lib/project";
import { actions } from "../lib/actions";
import { foldersOf, parseFileQuery, rankEntries, splitByRanges, textRows, type RankedEntry, type TextRow } from "../lib/finderModel";
import { gitApi, type SearchResult } from "../lib/git";
import { cn } from "../lib/layout";
import { relativeInside } from "../lib/paths";
import { IS_MAC } from "../lib/shortcuts";
import { Kbd, PromptCaret, PromptCursor } from "./ui";
import { basename } from "../lib/paths";

const LIMIT = 80;
const TEXT_DEBOUNCE_MS = 220;
const MIN_TEXT_QUERY = 2;

/** Lo último que se buscó como texto: al volver con ⌘⇧F sigue ahí (como en VS Code). */
const lastText = { query: "", caseSensitive: false, wholeWord: false, regex: false };
/**
 * Dónde buscar si no se pide una carpeta: todo el proyecto (como siempre) o
 * la carpeta de la terminal. Se recuerda lo último que elegiste.
 */
let lastScope: "project" | "here" = "project";
/** Id creciente por búsqueda: la nueva cancela en el backend la que siga corriendo. */
let searchSeq = Date.now();

const MOD_ENTER = IS_MAC ? "⌘↵" : "Ctrl+↵";

export const FileFinder: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const request = useUiStore((s) => s.finder);
  if (!request) return null;
  return <FinderPanel request={request} onClosed={onClosed} />;
};

/** Texto con las letras coincidentes resaltadas. */
const Highlighted: React.FC<{ text: string; positions: Set<number>; offset: number; className?: string }> = ({ text, positions, offset, className }) => (
  <span className={className}>
    {Array.from(text, (ch, i) =>
      positions.has(i + offset) ? (
        <b key={i} className="font-semibold text-accent">
          {ch}
        </b>
      ) : (
        ch
      ),
    )}
  </span>
);

/** Carpeta de la terminal relativa a la raíz (`""` = la raíz, null = fuera). */
function useHere(root: string | null): string | null {
  const cwd = useProjectStore((s) => s.cwd);
  if (!root || !cwd) return null;
  const rel = relativeInside(cwd, root);
  return rel === null ? null : rel.replace(/\\/g, "/");
}

const FinderPanel: React.FC<{ request: FinderRequest; onClosed: () => void }> = ({ request, onClosed }) => {
  const closeFinder = useUiStore((s) => s.closeFinder);
  const cwd = useProjectStore((s) => s.cwd);
  const root = projectRoot();
  const here = useHere(root);
  const [mode, setMode] = useState<FinderMode>(request.mode);
  // Alcance: la carpeta pedida (menú del árbol); si no, la última elección (proyecto o aquí).
  const [dir, setDir] = useState<string>(request.dir ?? (lastScope === "here" && here ? here : ""));
  const [customDir, setCustomDir] = useState<string | null>(request.dir && request.dir !== here ? request.dir : null);
  const [fileQuery, setFileQuery] = useState(request.mode === "files" ? (request.query ?? "") : "");
  const [text, setText] = useState(() => ({ ...lastText, query: request.mode === "text" && request.query ? request.query : lastText.query }));
  const [files, setFiles] = useState<string[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // ⌘P / ⌘⇧F con el buscador abierto cambian de modo sin perder lo escrito
  // (ajuste durante el render: el pedido es una prop que cambia).
  const [seen, setSeen] = useState(request);
  if (seen !== request) {
    setSeen(request);
    setMode(request.mode);
    if (request.dir !== undefined) {
      setDir(request.dir);
      setCustomDir(request.dir && request.dir !== here ? request.dir : null);
    }
    if (request.mode === "text" && request.query) setText((t) => ({ ...t, query: request.query ?? t.query }));
    setCursor(0);
  }
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select());
  }, [request]);

  useEffect(() => {
    let alive = true;
    projectFiles()
      .then((list) => alive && setFiles(list))
      .catch((err: unknown) => alive && setFilesError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const close = () => {
    closeFinder();
    onClosed();
  };

  const scopes = useMemo(() => {
    const list: Array<{ dir: string; label: string; removable?: boolean }> = [{ dir: "", label: root ? basename(root) : "Proyecto" }];
    if (here) list.push({ dir: here, label: here });
    if (customDir && customDir !== here) list.push({ dir: customDir, label: customDir, removable: true });
    return list;
  }, [root, here, customDir]);

  const switchMode = (next: FinderMode) => {
    setMode(next);
    setCursor(0);
    inputRef.current?.focus();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/60 px-4 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Buscar archivo" : "Buscar en archivos"}
        className="flex max-h-[76vh] w-full max-w-[760px] animate-pop-in flex-col overflow-hidden rounded-lg border border-[var(--glass-border)] glass"
      >
        <div className="flex items-center gap-1 border-b border-line px-2 pt-2">
          <div role="tablist" aria-label="Qué buscar" className="flex gap-1">
            {(
              [
                ["files", "Archivos", FileText, IS_MAC ? "⌘P" : "Ctrl+Shift+P"],
                ["text", "Texto en archivos", TextSearch, IS_MAC ? "⇧⌘F" : "Ctrl+Shift+Alt+F"],
              ] as const
            ).map(([id, label, Icon, keys]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mode === id}
                title={`${label}  ${keys}  (Tab cambia)`}
                onClick={() => switchMode(id)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 text-[12px] transition-colors duration-150",
                  mode === id ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
                )}
              >
                <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <div role="radiogroup" aria-label="Dónde buscar" className="flex min-w-0 items-center gap-1 pb-1">
            {scopes.map((scope) => (
              <span key={scope.dir || "/"} className="flex min-w-0">
                <button
                  type="button"
                  role="radio"
                  aria-checked={dir === scope.dir}
                  title={scope.dir ? `Solo en ${scope.dir}` : "Todo el proyecto"}
                  onClick={() => {
                    setDir(scope.dir);
                    if (!scope.dir) lastScope = "project";
                    else if (scope.dir === here) lastScope = "here";
                    setCursor(0);
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "flex h-6 min-w-0 max-w-[200px] items-center gap-1 rounded-md border px-2 font-mono text-[11px] transition-colors duration-150",
                    scope.removable && "rounded-r-none",
                    dir === scope.dir ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-ink-3 hover:text-ink-2",
                  )}
                >
                  {scope.dir ? <FolderSearch size={11} strokeWidth={1.9} aria-hidden="true" className="shrink-0" /> : null}
                  <span className="truncate">{scope.label}</span>
                </button>
                {scope.removable && (
                  <button
                    type="button"
                    aria-label={`Quitar ${scope.label}`}
                    onClick={() => {
                      setCustomDir(null);
                      if (dir === scope.dir) setDir(here ?? "");
                    }}
                    className="grid h-6 w-5 place-items-center rounded-r-md border border-l-0 border-line text-ink-3 hover:text-ink"
                  >
                    <X size={10} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>

        {mode === "files" ? (
          <FilesMode
            files={files}
            error={filesError}
            dir={dir}
            query={fileQuery}
            setQuery={setFileQuery}
            cursor={cursor}
            setCursor={setCursor}
            inputRef={inputRef}
            listRef={listRef}
            rootName={root ? basename(root) : null}
            onClose={close}
            onSwitch={() => switchMode("text")}
            onScope={(next) => {
              setCustomDir(next === here ? null : next);
              setDir(next);
              setFileQuery("");
              setCursor(0);
            }}
          />
        ) : (
          <TextMode
            root={root}
            dir={dir}
            state={text}
            setState={(next) => {
              Object.assign(lastText, next);
              setText(next);
            }}
            cursor={cursor}
            setCursor={setCursor}
            inputRef={inputRef}
            listRef={listRef}
            onClose={close}
            onSwitch={() => switchMode("files")}
          />
        )}
      </div>
    </div>
  );
};

interface ModeProps {
  cursor: number;
  setCursor: (n: number) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLUListElement | null>;
  onClose: () => void;
  /** Tab: al otro modo. */
  onSwitch: () => void;
}

/** Flechas, ⌃N/⌃P, Enter, Esc y Tab en el campo de búsqueda. */
function navigationKeys(e: React.KeyboardEvent, count: number, selected: number, props: ModeProps, pick: (inEditor: boolean) => void) {
  if (e.key === "Escape") props.onClose();
  else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) props.setCursor(Math.min(selected + 1, count - 1));
  else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) props.setCursor(Math.max(selected - 1, 0));
  else if (e.key === "PageDown") props.setCursor(Math.min(selected + 10, count - 1));
  else if (e.key === "PageUp") props.setCursor(Math.max(selected - 10, 0));
  else if (e.key === "Enter" && count > 0) pick(e.metaKey || e.ctrlKey);
  else if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) props.onSwitch();
  else return;
  e.preventDefault();
}

/* ------------------------------------------------------------------ */
/* Archivos y carpetas                                                 */
/* ------------------------------------------------------------------ */

const FilesMode: React.FC<
  ModeProps & {
    files: string[] | null;
    error: string | null;
    dir: string;
    query: string;
    setQuery: (q: string) => void;
    rootName: string | null;
    onScope: (dir: string) => void;
  }
> = (props) => {
  const { files, error, dir, query, setQuery, cursor, setCursor, inputRef, listRef, rootName } = props;
  const parsed = parseFileQuery(query);
  const folders = useMemo(() => (files ? foldersOf(files) : []), [files]);
  const results = useMemo(
    () => (files ? rankEntries(files, folders, dir, parsed.text, recentFiles(), LIMIT) : []),
    [files, folders, dir, parsed.text],
  );
  const selected = Math.min(cursor, Math.max(results.length - 1, 0));
  const current = results[selected];

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, listRef]);

  /** Archivo: verlo (o en tu editor). Carpeta: buscar dentro (o ir ahí en la terminal). */
  const pick = (entry: RankedEntry, inEditor: boolean) => {
    if (entry.isDir) {
      if (inEditor) {
        const abs = absolutePath(entry.path);
        props.onClose();
        if (abs) void actions.cdTo(abs);
      } else {
        props.onScope(entry.path);
      }
      return;
    }
    props.onClose();
    if (inEditor) void openInEditor(entry.path, parsed.line);
    else void openFile(entry.path, parsed.line ? { line: parsed.line, column: parsed.column ? parsed.column - 1 : undefined } : undefined);
  };

  const placeholder = !rootName ? "Abre una carpeta en la terminal" : dir ? `Archivo o carpeta en ${dir}…  (archivo:línea)` : `Archivo o carpeta en ${rootName}…  (archivo:línea)`;

  return (
    <>
      <SearchInput
        inputRef={inputRef}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setCursor(0);
        }}
        onKeyDown={(e) => navigationKeys(e, results.length, selected, props, (inEditor) => current && pick(current, inEditor))}
        placeholder={placeholder}
        controls="finder-results"
        active={results[selected] ? `finder-${selected}` : undefined}
        aside={files ? <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{files.length.toLocaleString("es-MX")}</span> : null}
      />
      <ul ref={listRef} id="finder-results" role="listbox" aria-label="Archivos" className="relative min-h-0 flex-1 overflow-y-auto py-1.5">
        {results.length > 0 && <PromptCursor as="li" index={selected} layoutKey={results} />}
        {error && <li className="px-4 py-6 text-[12.5px] text-signal">{error}</li>}
        {!error && !files && <li className="px-4 py-6 text-[12.5px] text-ink-3">Indexando archivos…</li>}
        {files && !results.length && <li className="px-4 py-6 text-[12.5px] text-ink-3">Ningún archivo ni carpeta coincide.</li>}
        {results.map((r, i) => {
          const slash = r.shown.lastIndexOf("/");
          const name = r.shown.slice(slash + 1);
          const parent = slash >= 0 ? r.shown.slice(0, slash) : "";
          const positions = new Set(r.positions);
          const Icon = r.isDir ? Folder : r.recent && !query ? History : FileText;
          return (
            <li
              key={r.path}
              id={`finder-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === selected}
              onMouseMove={() => i !== selected && setCursor(i)}
              onClick={(e) => pick(r, e.metaKey || e.ctrlKey)}
              className={cn(
                "relative mx-1.5 flex h-8 cursor-pointer items-center gap-2.5 rounded-md pl-7 pr-2.5 transition-colors duration-150",
                i === selected ? "text-ink" : "text-ink-2",
              )}
            >
              <Icon size={13} strokeWidth={1.75} aria-hidden="true" className={cn("shrink-0", i === selected ? "text-accent" : "text-ink-3")} />
              <span className="prompt-slot shrink-0 text-[12.5px]">
                <Highlighted text={r.isDir ? `${name}/` : name} positions={positions} offset={slash + 1} className="font-mono text-[12.5px]" />
                {i === selected && <PromptCaret />}
              </span>
              <Highlighted text={parent} positions={positions} offset={0} className="min-w-0 truncate font-mono text-[11.5px] text-ink-3" />
            </li>
          );
        })}
      </ul>
      <Footer>
        {current?.isDir ? (
          <>
            <span>
              <Kbd>↵</Kbd> buscar dentro
            </span>
            <span>
              <Kbd>{MOD_ENTER}</Kbd> ir ahí (cd)
            </span>
          </>
        ) : (
          <>
            <span>
              <Kbd>↵</Kbd> abrir{parsed.line ? ` en la línea ${parsed.line}` : ""}
            </span>
            <span>
              <Kbd>{MOD_ENTER}</Kbd> en tu editor
            </span>
          </>
        )}
        <span>
          <Kbd>tab</Kbd> texto
        </span>
      </Footer>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Texto dentro de los archivos                                        */
/* ------------------------------------------------------------------ */

type TextState = typeof lastText;

type Phase =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; result: SearchResult; ms: number }
  | { kind: "error"; message: string };

const TextMode: React.FC<ModeProps & { root: string | null; dir: string; state: TextState; setState: (s: TextState) => void }> = (props) => {
  const { root, dir, state, setState, cursor, setCursor, inputRef, listRef } = props;
  const [searchPhase, setPhase] = useState<Phase>({ kind: "idle" });
  const query = state.query;
  const searchable = Boolean(root) && query.trim().length >= MIN_TEXT_QUERY;
  const phase: Phase = searchable ? searchPhase : { kind: "idle" };

  useEffect(() => {
    if (!root || !searchable) return;
    let alive = true;
    const timer = setTimeout(() => {
      const id = ++searchSeq;
      const started = performance.now();
      setPhase({ kind: "searching" });
      gitApi
        .search(root, { query, caseSensitive: state.caseSensitive, wholeWord: state.wholeWord, regex: state.regex, dir }, id)
        .then((result) => {
          if (!alive || result.cancelled) return;
          setPhase({ kind: "done", result, ms: Math.round(performance.now() - started) });
          setCursor(0);
        })
        .catch((err: unknown) => alive && setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
    }, TEXT_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [root, searchable, dir, query, state.caseSensitive, state.wholeWord, state.regex, setCursor]);

  // Mientras busca lo nuevo, se siguen viendo los resultados anteriores (no parpadea al escribir).
  const [last, setLast] = useState<SearchResult | null>(null);
  if (phase.kind === "done" && phase.result !== last) setLast(phase.result);
  const result = searchable ? (phase.kind === "done" ? phase.result : last) : null;
  const rows = useMemo(() => textRows(result), [result]);
  const matches = rows.filter((r): r is Extract<TextRow, { kind: "match" }> => r.kind === "match");
  const selected = Math.min(cursor, Math.max(matches.length - 1, 0));
  const current = matches[selected];

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, listRef]);

  const pick = (row: Extract<TextRow, { kind: "match" }>, inEditor: boolean) => {
    props.onClose();
    if (inEditor) void openInEditor(row.path, row.match.line);
    else void openFile(row.path, { line: row.match.line, column: row.match.column, length: row.match.length });
  };

  const toggle = (key: "caseSensitive" | "wholeWord" | "regex") => {
    setState({ ...state, [key]: !state[key] });
    inputRef.current?.focus();
  };

  const options = (
    <span className="flex shrink-0 items-center gap-0.5">
      {(
        [
          ["caseSensitive", CaseSensitive, "Distinguir mayúsculas", "C"],
          ["wholeWord", WholeWord, "Palabra completa", "W"],
          ["regex", Regex, "Expresión regular", "R"],
        ] as const
      ).map(([key, Icon, label, letter]) => (
        <button
          key={key}
          type="button"
          aria-pressed={state[key]}
          title={`${label}  ${IS_MAC ? `⌥⌘${letter}` : `Alt+${letter}`}`}
          onClick={() => toggle(key)}
          className={cn(
            "grid size-6 place-items-center rounded transition-colors duration-150",
            state[key] ? "bg-accent/15 text-accent" : "text-ink-3 hover:bg-hover hover:text-ink",
          )}
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ))}
    </span>
  );

  const summary = (() => {
    if (!root) return "Abre una carpeta en la terminal.";
    if (phase.kind === "idle") return query.trim() ? `Escribe al menos ${MIN_TEXT_QUERY} caracteres.` : `Busca texto en ${dir || basename(root)}: código, mensajes de error, TODOs…`;
    if (phase.kind === "searching") return "Buscando…";
    if (phase.kind === "error") return phase.message;
    const r = phase.result;
    const files = r.files.length;
    const head = r.total
      ? `${r.total.toLocaleString("es-MX")} ${r.total === 1 ? "línea" : "líneas"} en ${files} ${files === 1 ? "archivo" : "archivos"}`
      : "Sin coincidencias";
    const extra = [
      `${r.searched.toLocaleString("es-MX")} leídos · ${phase.ms} ms`,
      r.truncated ? "se muestran las primeras: afina la búsqueda" : null,
      r.skipped ? `${r.skipped} sin leer (más de 2 MB o solo en iCloud)` : null,
    ].filter(Boolean);
    return `${head} · ${extra.join(" · ")}`;
  })();

  return (
    <>
      <SearchInput
        inputRef={inputRef}
        value={query}
        onChange={(v) => setState({ ...state, query: v })}
        onKeyDown={(e) => {
          if (e.altKey && (e.metaKey || !IS_MAC) && ["c", "w", "r"].includes(e.code.replace("Key", "").toLowerCase())) {
            e.preventDefault();
            const letter = e.code.replace("Key", "").toLowerCase();
            toggle(letter === "c" ? "caseSensitive" : letter === "w" ? "wholeWord" : "regex");
            return;
          }
          navigationKeys(e, matches.length, selected, props, (inEditor) => current && pick(current, inEditor));
        }}
        placeholder={root ? `Texto en ${dir || basename(root)}…` : "Abre una carpeta en la terminal"}
        controls="finder-results"
        active={current ? `finder-${selected}` : undefined}
        aside={options}
      />
      <p
        role="status"
        className={cn("shrink-0 border-b border-line px-4 py-1.5 text-[11.5px]", phase.kind === "error" ? "text-signal" : "text-ink-3")}
      >
        {summary}
      </p>
      <ul ref={listRef} id="finder-results" role="listbox" aria-label="Coincidencias" className="relative min-h-0 flex-1 overflow-y-auto py-1">
        {matches.length > 0 && <PromptCursor as="li" index={selected} layoutKey={rows} />}
        {rows.map((row) => {
          if (row.kind === "file") {
            const slash = row.path.lastIndexOf("/");
            return (
              <li key={`f:${row.path}`} role="presentation" className="mx-1.5 mt-1.5 flex h-7 items-center gap-2 px-2 first:mt-0">
                <FileText size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
                <span className="shrink-0 font-mono text-[12.5px] text-ink">{row.path.slice(slash + 1)}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">{slash >= 0 ? row.path.slice(0, slash) : ""}</span>
                <span className="ml-auto shrink-0 rounded-full bg-hover px-1.5 font-mono text-[10.5px] tabular-nums leading-4 text-ink-3">
                  {row.count}
                  {row.more ? "+" : ""}
                </span>
              </li>
            );
          }
          const i = row.index;
          return (
            <li
              key={`m:${row.path}:${row.match.line}`}
              id={`finder-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === selected}
              aria-label={`${row.path} línea ${row.match.line}: ${row.match.preview}`}
              onMouseMove={() => i !== selected && setCursor(i)}
              onClick={(e) => pick(row, e.metaKey || e.ctrlKey)}
              className={cn(
                "relative mx-1.5 flex h-7 cursor-pointer items-center gap-3 rounded-md pl-7 pr-2.5 font-mono text-[12px] transition-colors duration-150",
                i === selected ? "text-ink" : "text-ink-2",
              )}
            >
              <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-ink-3">{row.match.line}</span>
              <span className="min-w-0 truncate whitespace-pre">
                {splitByRanges(row.match.preview, row.match.ranges).map((part, k) =>
                  part.hit ? (
                    <mark key={k} className="rounded-[2px] bg-accent/25 px-px text-ink">
                      {part.text}
                    </mark>
                  ) : (
                    <React.Fragment key={k}>{part.text}</React.Fragment>
                  ),
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <Footer>
        <span>
          <Kbd>↵</Kbd> abrir en la línea
        </span>
        <span>
          <Kbd>{MOD_ENTER}</Kbd> en tu editor
        </span>
        <span>
          <Kbd>tab</Kbd> archivos
        </span>
      </Footer>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Piezas comunes                                                      */
/* ------------------------------------------------------------------ */

const SearchInput: React.FC<{
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder: string;
  controls: string;
  active?: string;
  aside?: React.ReactNode;
}> = ({ inputRef, value, onChange, onKeyDown, placeholder, controls, active, aside }) => {
  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-3.5">
      <Search size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded="true"
        aria-controls={controls}
        aria-activedescendant={active}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-12 min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3"
      />
      {aside}
    </div>
  );
};

const Footer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-4 border-t border-line bg-chrome px-3.5 py-2 text-[11.5px] text-ink-3">
    {children}
    <span className="ml-auto">
      <Kbd>esc</Kbd>
    </span>
  </div>
);
