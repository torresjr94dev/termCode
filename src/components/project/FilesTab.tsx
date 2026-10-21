import React, { useEffect, useMemo } from "react";
import { ChevronRight, CornerDownLeft, RefreshCw } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import type { FsEntry } from "../../lib/git";
import { absolutePath, loadDir, openFile, pastePath, projectRoot, toggleDir } from "../../lib/project";
import { cn } from "../../lib/layout";
import { IconButton } from "../ui";
import { EmptyState, StatusLetter, tildify } from "./common";

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

export const FilesTab: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const cwd = useProjectStore((s) => s.cwd);
  const rootNode = useProjectStore((s) => s.tree[""]);
  const root = repo?.root ?? cwd;

  useEffect(() => {
    if (root && rootNode === undefined) void loadDir("");
  }, [root, rootNode]);

  if (!root) return <EmptyState title="Sin carpeta" detail="Esperando a saber dónde está el panel activo." />;

  const refresh = () => {
    const { expanded } = useProjectStore.getState();
    void loadDir("");
    Object.keys(expanded).forEach((path) => void loadDir(path));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3" title={root}>
          {tildify(projectRoot() ?? root)}
        </span>
        <IconButton icon={RefreshCw} label="Recargar archivos" size="sm" onClick={refresh} />
      </div>
      <div role="tree" aria-label="Archivos del proyecto" className="min-h-0 flex-1 overflow-y-auto pb-3">
        <TreeLevel path="" depth={0} />
      </div>
    </div>
  );
};

const TreeLevel: React.FC<{ path: string; depth: number }> = ({ path, depth }) => {
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
        <TreeRow key={entry.path} entry={entry} depth={depth} marks={marks} />
      ))}
    </ul>
  );
};

const TreeRow: React.FC<{ entry: FsEntry; depth: number; marks: ReturnType<typeof useChangeMarks> }> = ({
  entry,
  depth,
  marks,
}) => {
  const expanded = useProjectStore((s) => Boolean(s.expanded[entry.path]));
  const isViewing = useProjectStore((s) => s.viewer?.kind === "file" && s.viewer.path === entry.path);
  const letter = entry.isDir ? undefined : marks.files.get(entry.path);
  const dirChanged = entry.isDir && marks.dirs.has(entry.path);

  return (
    <li role="treeitem" aria-expanded={entry.isDir ? expanded : undefined} aria-selected={isViewing}>
      <div className="group relative flex items-center">
        <button
          type="button"
          onClick={() => (entry.isDir ? toggleDir(entry.path) : void openFile(entry.path))}
          title={entry.path}
          style={{ paddingLeft: 10 + depth * 14 }}
          className={cn(
            "flex h-[26px] min-w-0 flex-1 items-center gap-1.5 pr-8 text-left transition-colors duration-150",
            isViewing ? "bg-press text-ink" : "hover:bg-hover",
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
          <span className="flex-1" />
          {letter && <StatusLetter letter={letter} className="mr-1" />}
        </button>
        {!entry.isDir && (
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
      {entry.isDir && expanded && <TreeLevel path={entry.path} depth={depth + 1} />}
    </li>
  );
};
