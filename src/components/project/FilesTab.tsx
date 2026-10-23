import React, { useEffect, useMemo, useRef } from "react";
import { ChevronRight, CornerDownLeft, FolderUp, RefreshCw } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import type { FsEntry } from "../../lib/git";
import { absolutePath, loadDir, openFile, pastePath, toggleDir } from "../../lib/project";
import { actions } from "../../lib/actions";
import { breadcrumbs, parentDir } from "../../lib/cd";
import { relativeInside } from "../../lib/paths";
import { cn } from "../../lib/layout";
import { terminalManager } from "../../terminal/TerminalManager";
import { IconButton } from "../ui";
import { EmptyState, StatusLetter } from "./common";

/** path → letra (archivos) y carpetas que contienen cambios. */
function useChangeMarks() {
  const changes = useProjectStore((s) => s.status?.changes);
  return useMemo(() => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    for (const c of changes ?? []) {
      const letter = c.conflicted ? "!" : c.untracked ? "U" : c.worktree !== "." ? c.worktree : c.index;
      files.set(c.path, letter);
      const parts = c.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return { files, dirs };
  }, [changes]);
}

/** Dónde está la terminal, relativo a la raíz del árbol (`""` = la raíz, null = fuera). */
function useHere(root: string | null): string | null {
  const cwd = useProjectStore((s) => s.cwd);
  if (!root || !cwd) return null;
  const rel = relativeInside(cwd, root);
  return rel === null ? null : rel.replace(/\\/g, "/");
}

export const FilesTab: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const cwd = useProjectStore((s) => s.cwd);
  const rootNode = useProjectStore((s) => s.tree[""]);
  const root = repo?.root ?? cwd;
  const here = useHere(root);

  useEffect(() => {
    if (root && rootNode === undefined) void loadDir("");
  }, [root, rootNode]);

  // El árbol sigue a la terminal: tras un `cd` dentro del proyecto, se abre el camino hasta ahí.
  useEffect(() => {
    if (!here) return;
    const { expanded, tree, set } = useProjectStore.getState();
    const parts = here.split("/");
    const next = { ...expanded };
    let changed = false;
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (next[path]) continue;
      next[path] = true;
      changed = true;
      if (!Array.isArray(tree[path])) void loadDir(path);
    }
    if (changed) set({ expanded: next });
  }, [here]);

  if (!root) return <EmptyState title="Sin carpeta" detail="Esperando a saber dónde está el panel activo." />;

  const refresh = () => {
    const { expanded } = useProjectStore.getState();
    void loadDir("");
    Object.keys(expanded).forEach((path) => void loadDir(path));
  };
  const up = cwd ? parentDir(cwd) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 pl-2 pr-1.5">
        <IconButton
          icon={FolderUp}
          label={up ? "Subir una carpeta (cd ..)" : "Ya estás en la raíz"}
          size="sm"
          disabled={!up}
          onClick={() => up && void actions.cdTo(up)}
          className="disabled:opacity-40"
        />
        {cwd ? <Breadcrumbs path={cwd} /> : <span className="flex-1" />}
        <IconButton icon={RefreshCw} label="Recargar archivos" size="sm" onClick={refresh} />
      </div>
      <div role="tree" aria-label="Archivos del proyecto" className="min-h-0 flex-1 overflow-y-auto pb-3">
        <TreeLevel path="" depth={0} here={here} />
      </div>
      <p className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-ink-3">Doble clic en una carpeta: la terminal va ahí (cd).</p>
    </div>
  );
};

/** La carpeta de la terminal, tramo a tramo: cada uno lleva ahí con un clic. */
const Breadcrumbs: React.FC<{ path: string }> = ({ path }) => {
  const crumbs = breadcrumbs(path, terminalManager.getHome());
  const scroller = useRef<HTMLElement | null>(null);
  // El final (dónde estás) siempre a la vista; lo de arriba se recorre de lado.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [path]);
  return (
    <nav ref={scroller} aria-label="Carpeta de la terminal" title={path} className="scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto">
      <ol className="flex items-center font-mono text-[11px]">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={crumb.path} className="flex shrink-0 items-center">
              {i > 0 && <ChevronRight size={10} strokeWidth={2} aria-hidden="true" className="mx-px text-ink-3/60" />}
              <button
                type="button"
                aria-current={last ? "location" : undefined}
                disabled={last}
                onClick={() => void actions.cdTo(crumb.path)}
                className={cn(
                  "rounded px-1 leading-5 transition-colors duration-150",
                  last ? "font-medium text-ink" : "text-ink-3 hover:bg-hover hover:text-ink",
                )}
              >
                {crumb.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

const TreeLevel: React.FC<{ path: string; depth: number; here: string | null }> = ({ path, depth, here }) => {
  const node = useProjectStore((s) => s.tree[path]);
  const marks = useChangeMarks();
  const pad = 10 + depth * 14;

  if (node === undefined || node === "loading") {
    return (
      <p className="py-1 text-[12px] text-ink-3" style={{ paddingLeft: pad + 18 }}>
        Cargando…
      </p>
    );
  }
  if (!Array.isArray(node)) {
    return (
      <p className="py-1 text-[12px] text-signal" style={{ paddingLeft: pad + 18 }}>
        {node.error}
      </p>
    );
  }
  if (!node.length) {
    return (
      <p className="py-1 text-[12px] text-ink-3" style={{ paddingLeft: pad + 18 }}>
        Vacía
      </p>
    );
  }
  return (
    <ul role="group">
      {node.map((entry) => (
        <TreeRow key={entry.path} entry={entry} depth={depth} marks={marks} here={here} />
      ))}
    </ul>
  );
};

const TreeRow: React.FC<{ entry: FsEntry; depth: number; marks: ReturnType<typeof useChangeMarks>; here: string | null }> = ({
  entry,
  depth,
  marks,
  here,
}) => {
  const expanded = useProjectStore((s) => Boolean(s.expanded[entry.path]));
  const isViewing = useProjectStore((s) => s.viewer?.kind === "file" && s.viewer.path === entry.path);
  const letter = entry.isDir ? undefined : marks.files.get(entry.path);
  const dirChanged = entry.isDir && marks.dirs.has(entry.path);
  const isHere = entry.isDir && here === entry.path;
  const row = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isHere) row.current?.scrollIntoView({ block: "nearest" });
  }, [isHere]);

  const goHere = () => {
    const abs = absolutePath(entry.path);
    if (abs) void actions.cdTo(abs);
  };

  return (
    <li role="treeitem" aria-expanded={entry.isDir ? expanded : undefined} aria-selected={isViewing || isHere}>
      <div className="group relative flex items-center">
        <button
          ref={row}
          type="button"
          // El segundo clic de un doble clic no vuelve a plegar lo que el primero abrió.
          onClick={(e) => {
            if (!entry.isDir) void openFile(entry.path);
            else if (e.detail < 2) toggleDir(entry.path);
          }}
          onDoubleClick={entry.isDir ? goHere : undefined}
          title={entry.isDir ? `${entry.path}\nDoble clic: cd aquí` : entry.path}
          style={{ paddingLeft: 10 + depth * 14 }}
          className={cn(
            "flex h-[26px] min-w-0 flex-1 select-none items-center gap-1.5 pr-8 text-left transition-colors duration-150",
            isViewing ? "bg-press text-ink" : isHere ? "bg-accent/[0.07] text-ink" : "hover:bg-hover",
            entry.ignored ? "text-ink-3/70" : "text-ink-2 hover:text-ink",
          )}
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            className={cn(
              "shrink-0 text-ink-3 transition-transform duration-150",
              entry.isDir ? (expanded ? "rotate-90" : "") : "invisible",
            )}
          />
          <span className={cn("min-w-0 truncate font-mono text-[12px]", entry.isDir && "font-medium")}>{entry.name}</span>
          {dirChanged && <span aria-label="Contiene cambios" className="size-1.5 shrink-0 rounded-[1px] bg-accent/70" />}
          {isHere && (
            <span className="shrink-0 rounded-full border border-accent/40 px-1.5 font-mono text-[9.5px] leading-[14px] text-accent">
              aquí
            </span>
          )}
          <span className="flex-1" />
          {letter && <StatusLetter letter={letter} className="mr-1" />}
        </button>
        {entry.isDir ? (
          !isHere && (
            <button
              type="button"
              aria-label={`Ir a ${entry.name} en la terminal (cd)`}
              title="cd aquí"
              onClick={goHere}
              className="absolute right-1.5 grid h-5 place-items-center rounded px-1 font-mono text-[10px] text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-press hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
            >
              cd
            </button>
          )
        ) : (
          <button
            type="button"
            aria-label={`Pegar la ruta de ${entry.name} en la terminal`}
            title="Pegar la ruta en la terminal"
            onClick={() => {
              const abs = absolutePath(entry.path);
              if (abs) pastePath(abs);
            }}
            className="absolute right-1.5 grid size-6 place-items-center rounded text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-press hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
          >
            <CornerDownLeft size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
      {entry.isDir && expanded && <TreeLevel path={entry.path} depth={depth + 1} here={here} />}
    </li>
  );
};
