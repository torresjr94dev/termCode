import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CaseSensitive, X } from "lucide-react";
import { terminalManager } from "../terminal/TerminalManager";
import { useUiStore } from "../store/uiStore";
import { cn } from "../lib/layout";
import { IconButton } from "./ui";
import { shiftLabel } from "../lib/shortcuts";

/** Búsqueda en el scrollback del panel (⌘F). Enter: siguiente · ⇧Enter: anterior · Esc: cerrar. */
export const FindBar: React.FC<{ paneId: string }> = ({ paneId }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const setFindPane = useUiStore((s) => s.setFindPane);

  useEffect(() => {
    inputRef.current?.focus();
    const unsubscribe = terminalManager.onSearchResults(paneId, (index, count) => setResults({ index, count }));
    return () => {
      unsubscribe();
      terminalManager.clearSearch(paneId);
    };
  }, [paneId]);

  const search = (opts: { backwards?: boolean; incremental?: boolean } = {}) =>
    terminalManager.find(paneId, query, { caseSensitive, ...opts });

  // Mientras se escribe, la coincidencia se amplía en el sitio (incremental).
  useEffect(() => {
    terminalManager.find(paneId, query, { caseSensitive, incremental: true });
  }, [paneId, query, caseSensitive]);

  const close = () => {
    setFindPane(null);
    terminalManager.focus(paneId);
  };

  const summary = !query
    ? ""
    : results && results.count > 0
      ? `${results.index + 1}/${results.count}`
      : "0/0";

  return (
    <div
      role="search"
      className="absolute right-3 top-2 z-20 flex h-9 animate-pop-in items-center gap-1 rounded-md border border-[var(--glass-border)] glass pl-3 pr-1"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            search({ backwards: e.shiftKey });
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Buscar en el terminal"
        aria-label="Buscar en el terminal"
        spellCheck={false}
        className="w-48 select-text bg-transparent font-mono text-[12px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3"
      />
      <span
        aria-live="polite"
        className={cn(
          "w-12 text-right font-mono text-[11px] tabular-nums",
          query && results?.count === 0 ? "text-signal" : "text-ink-3",
        )}
      >
        {summary}
      </span>
      <IconButton
        size="sm"
        icon={CaseSensitive}
        label="Distinguir mayúsculas"
        pressed={caseSensitive}
        onClick={() => setCaseSensitive((v) => !v)}
      />
      <IconButton size="sm" icon={ArrowUp} label="Anterior" shortcut={shiftLabel("↵")} onClick={() => search({ backwards: true })} />
      <IconButton size="sm" icon={ArrowDown} label="Siguiente" shortcut="↵" onClick={() => search()} />
      <IconButton size="sm" icon={X} label="Cerrar búsqueda" shortcut="esc" onClick={close} />
    </div>
  );
};
