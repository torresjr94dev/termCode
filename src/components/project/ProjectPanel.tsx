import React from "react";
import { FolderGit2, X } from "lucide-react";
import { useProjectStore, type ProjectTab } from "../../store/projectStore";
import { closeProject, openProject } from "../../lib/project";
import { cn } from "../../lib/layout";
import { shortcutLabel } from "../../lib/shortcuts";
import { IconButton } from "../ui";
import { ChangesTab } from "./ChangesTab";
import { FilesTab } from "./FilesTab";
import { HistoryTab } from "./HistoryTab";

const TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: "files", label: "Archivos" },
  { id: "changes", label: "Cambios" },
  { id: "history", label: "Historial" },
];

/** Panel derecho: sigue el repositorio de la carpeta del panel activo. */
export const ProjectPanel: React.FC = () => {
  const isOpen = useProjectStore((s) => s.isOpen);
  const tab = useProjectStore((s) => s.tab);
  const repo = useProjectStore((s) => s.repo);
  const cwd = useProjectStore((s) => s.cwd);
  const changeCount = useProjectStore((s) => s.status?.changes.length ?? 0);

  if (!isOpen) return null;
  const title = repo?.name ?? cwd?.split("/").filter(Boolean).pop() ?? "Proyecto";

  return (
    <aside aria-label="Proyecto" className="flex h-full w-[360px] shrink-0 flex-col border-l border-line bg-chrome">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5">
        <FolderGit2 size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={repo?.root ?? cwd ?? undefined}>
          {title}
        </h2>
        <IconButton icon={X} label="Cerrar panel de proyecto" size="sm" onClick={closeProject} />
      </div>

      <div role="tablist" aria-label="Vistas del proyecto" className="flex shrink-0 gap-1 border-b border-line px-2 py-1.5">
        {TABS.map(({ id, label }) => {
          const selected = tab === id;
          const hint = id === "files" ? shortcutLabel("projectFiles") : id === "changes" ? shortcutLabel("projectChanges") : "";
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              title={hint ? `${label}  ${hint}` : label}
              onClick={() => (selected ? undefined : openProject(id))}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] transition-colors duration-150",
                selected ? "bg-press text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
              )}
            >
              {label}
              {id === "changes" && changeCount > 0 && (
                <span className={cn("font-mono text-[11px] tabular-nums", selected ? "text-amber" : "text-ink-3")}>
                  {changeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {tab === "files" && <FilesTab />}
        {tab === "changes" && <ChangesTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </aside>
  );
};
