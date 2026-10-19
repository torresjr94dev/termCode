import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, Cloud, GitBranch, Plus, Search } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { gitApi, type GitBranch as Branch } from "../../lib/git";
import { switchBranch } from "../../lib/project";
import { fuzzyFilter } from "../../lib/fuzzy";
import { formatAgo } from "../../lib/format";
import { cn } from "../../lib/layout";

type Item = { kind: "branch"; branch: Branch } | { kind: "create"; name: string };

/** Lo que el usuario escribe → nombre de rama razonable (espacios a guiones). */
const toBranchName = (text: string) => text.trim().replace(/\s+/g, "-");

/** Selector de ramas: se despliega sobre la barra de sincronización. */
export const BranchPicker: React.FC = () => {
  const open = useProjectStore((s) => s.isBranchPickerOpen);
  if (!open) return null;
  return <PickerPanel />;
};

const PickerPanel: React.FC = () => {
  const root = useProjectStore((s) => s.repo?.root);
  const current = useProjectStore((s) => s.status?.branch);
  const set = useProjectStore((s) => s.set);
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Fecha de referencia fija mientras el selector está abierto.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    inputRef.current?.focus();
    if (!root) return;
    let alive = true;
    gitApi
      .branches(root)
      .then((list) => alive && setBranches(list))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [root]);

  const items = useMemo<Item[]>(() => {
    if (!branches) return [];
    const q = query.trim();
    const matched = q ? fuzzyFilter(branches, q, (b) => b.name, 80).map((r) => r.item) : branches;
    const name = toBranchName(q);
    const exists = branches.some((b) => b.name === name || (b.remote && b.name.replace(/^[^/]+\//, "") === name));
    const list: Item[] = matched.map((branch) => ({ kind: "branch", branch }));
    if (name && !exists) list.push({ kind: "create", name });
    return list;
  }, [branches, query]);

  const selected = Math.min(cursor, Math.max(items.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = () => set({ isBranchPickerOpen: false });

  const pick = (item: Item) => {
    close();
    if (item.kind === "create") void switchBranch(item.name, { create: true });
    else if (!item.branch.current) void switchBranch(item.branch.name, { remote: item.branch.remote });
  };

  return (
    <>
      <div className="fixed inset-0 z-30" aria-hidden="true" onMouseDown={close} />
      <div
        role="dialog"
        aria-label="Cambiar de rama"
        className="absolute bottom-full left-2 right-2 z-40 mb-1.5 flex max-h-[min(440px,60vh)] animate-pop-in flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_16px_48px_-12px_rgb(0_0_0/0.7)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
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
                e.stopPropagation();
                close();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor(Math.min(selected + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor(Math.max(selected - 1, 0));
              } else if (e.key === "Enter" && items[selected]) {
                e.preventDefault();
                pick(items[selected]);
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="branch-results"
            placeholder="Cambiar a… o escribe un nombre nuevo"
            spellCheck={false}
            className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3"
          />
        </div>
        <ul ref={listRef} id="branch-results" role="listbox" aria-label="Ramas" className="min-h-0 flex-1 overflow-y-auto py-1">
          {error && <li className="px-3 py-4 text-[12px] text-signal">{error}</li>}
          {!error && !branches && <li className="px-3 py-4 text-[12px] text-ink-3">Leyendo ramas…</li>}
          {items.map((item, i) => (
            <li
              key={item.kind === "create" ? "__create" : item.branch.name}
              data-index={i}
              role="option"
              aria-selected={i === selected}
              onMouseMove={() => i !== selected && setCursor(i)}
              onClick={() => pick(item)}
              className={cn(
                "mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                i === selected ? "bg-press" : "",
                item.kind === "create" && "mt-1 border-t border-line pt-2",
              )}
            >
              {item.kind === "create" ? (
                <>
                  <Plus size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-amber" />
                  <span className="min-w-0 truncate text-[12.5px] text-ink">
                    Crear <span className="font-mono">{item.name}</span>
                    <span className="text-ink-3"> desde {current ?? "HEAD"}</span>
                  </span>
                </>
              ) : (
                <BranchRow branch={item.branch} now={now} />
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
};

const BranchRow: React.FC<{ branch: Branch; now: number }> = ({ branch, now }) => (
  <>
    {branch.current ? (
      <Check size={13} strokeWidth={2} aria-label="Rama actual" className="shrink-0 text-amber" />
    ) : branch.remote ? (
      <Cloud size={13} strokeWidth={1.75} aria-label="Solo en el remoto" className="shrink-0 text-ink-3" />
    ) : (
      <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
    )}
    <span className="min-w-0 flex-1">
      <span className={cn("block truncate font-mono text-[12.5px]", branch.current ? "text-ink" : "text-ink-2")}>{branch.name}</span>
      <span className="block truncate text-[11px] text-ink-3" title={branch.subject}>
        {branch.updatedAt ? formatAgo(branch.updatedAt * 1000, now) : ""} · {branch.subject}
      </span>
    </span>
    {(branch.ahead > 0 || branch.behind > 0) && (
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">
        ↑{branch.ahead} ↓{branch.behind}
      </span>
    )}
  </>
);
