import React from "react";
import { CloudAlert, FolderGit2, LayoutTemplate, FolderTree, GitCompareArrows, History, PanelRightClose, PanelRightOpen, RefreshCw, type LucideIcon } from "lucide-react";
import { useProjectStore, type ProjectTab } from "../../store/projectStore";
import { closeProject, openProject, retryStatus } from "../../lib/project";
import { cn } from "../../lib/layout";
import { shortcutLabel } from "../../lib/shortcuts";
import { IconButton } from "../ui";
import { ChangesTab } from "./ChangesTab";
import { FilesTab } from "./FilesTab";
import { HistoryTab } from "./HistoryTab";
import { basename } from "../../lib/paths";
import { openWorkspace } from "../../lib/workspace";
import { WORKSPACE_FILE } from "../../lib/workspaceFile";

const TABS: Array<{ id: ProjectTab; label: string; icon: LucideIcon }> = [
  { id: "files", label: "Archivos", icon: FolderTree },
  { id: "changes", label: "Cambios", icon: GitCompareArrows },
  { id: "history", label: "Historial", icon: History },
];

const hintFor = (id: ProjectTab) => (id === "files" ? shortcutLabel("projectFiles") : id === "changes" ? shortcutLabel("projectChanges") : "");

/**
 * Panel derecho: sigue el repositorio de la carpeta del panel activo. Abierto
 * de entrada; plegado queda como un riel con sus vistas a un clic.
 */
export const ProjectPanel: React.FC = () => {
  const isOpen = useProjectStore((s) => s.isOpen);
  const tab = useProjectStore((s) => s.tab);
  const repo = useProjectStore((s) => s.repo);
  const cwd = useProjectStore((s) => s.cwd);
  const changeCount = useProjectStore((s) => s.status?.changes.length ?? 0);
  const hasWorkspace = useProjectStore((s) => {
    const rootEntries = s.tree[""];
    return Array.isArray(rootEntries) && rootEntries.some((e) => e.name === WORKSPACE_FILE && !e.isDir);
  });

  if (!isOpen) return <ProjectRail changeCount={changeCount} />;
  const title = repo?.name ?? (cwd ? basename(cwd) : "Proyecto");

  return (
    <aside
      aria-label="Proyecto"
      className="flex h-full w-[clamp(260px,28vw,360px)] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-canvas"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5">
        <FolderGit2 size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={repo?.root ?? cwd ?? undefined}>
          {title}
        </h2>
        {hasWorkspace && (
          <button
            type="button"
            onClick={() => void openWorkspace()}
            title={`Abrir los paneles de ${WORKSPACE_FILE}`}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-[11.5px] text-ink-2 transition-colors duration-150 hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <LayoutTemplate size={12} strokeWidth={1.9} aria-hidden="true" />
            Workspace
          </button>
        )}
        <IconButton icon={PanelRightClose} label="Plegar panel de proyecto" shortcut={hintFor(tab)} size="sm" onClick={closeProject} />
      </div>

      <div role="tablist" aria-label="Vistas del proyecto" className="flex shrink-0 gap-1 border-b border-line px-2 py-1.5">
        {TABS.map(({ id, label }) => {
          const selected = tab === id;
          const hint = hintFor(id);
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
                <span className={cn("font-mono text-[11px] tabular-nums", selected ? "text-accent" : "text-ink-3")}>
                  {changeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <StatusTrouble />

      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {tab === "files" && <FilesTab />}
        {tab === "changes" && <ChangesTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </aside>
  );
};

/** El panel plegado: sus vistas como íconos, con los cambios contados. */
const ProjectRail: React.FC<{ changeCount: number }> = ({ changeCount }) => (
  <aside aria-label="Proyecto (plegado)" className="flex h-full w-10 shrink-0 flex-col items-center gap-1 rounded-xl border border-line bg-canvas py-1.5">
    <IconButton icon={PanelRightOpen} label="Mostrar panel de proyecto" onClick={() => openProject(useProjectStore.getState().tab)} />
    <span aria-hidden="true" className="my-0.5 h-px w-5 bg-line" />
    {TABS.map(({ id, label, icon }) => {
      const hint = hintFor(id);
      return (
        <span key={id} className="relative">
          <IconButton icon={icon} label={label} shortcut={hint || undefined} onClick={() => openProject(id)} />
          {id === "changes" && changeCount > 0 && (
            <span className="pointer-events-none absolute -right-1 -top-1 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[9.5px] font-semibold leading-4 tabular-nums text-on-accent">
              {changeCount > 99 ? "99+" : changeCount}
            </span>
          )}
        </span>
      );
    })}
  </aside>
);

/**
 * `git status` no terminó. Si el repo vive en iCloud (u otra nube con
 * «Optimizar almacenamiento»), esa es casi siempre la causa: se dice tal cual.
 */
const StatusTrouble: React.FC = () => {
  const trouble = useProjectStore((s) => s.statusTrouble);
  const repo = useProjectStore((s) => s.repo);
  const provider = useProjectStore((s) => s.cloudProvider);
  if (!trouble || !repo || trouble.root !== repo.root) return null;
  return (
    <div role="status" className="shrink-0 border-b border-warn/30 bg-warn/[0.07] px-3 py-2.5 text-[12px] leading-[1.45]">
      <p className="flex items-center gap-1.5 font-medium text-warn">
        <CloudAlert size={13} strokeWidth={2} aria-hidden="true" className="shrink-0" />
        git no responde en {repo.name}
      </p>
      <p className="mt-1 text-ink-2">
        {provider
          ? `El repo está en ${provider}. Con «Optimizar almacenamiento», macOS borra la copia local de archivos que no usas y git se queda esperando a que se descarguen. Mueve tus repos fuera de Documentos y Escritorio (p. ej. a ~/Developer) o marca la carpeta como «Mantener descargado» en Finder.`
          : "git status tardó más de 20 s y se canceló. Se reintenta solo, cada vez con más espera, para no saturar el disco."}
      </p>
      <button
        type="button"
        onClick={retryStatus}
        className="mt-2 flex h-6 items-center gap-1.5 rounded-md border border-line px-2 text-[11.5px] text-ink-2 transition-colors duration-150 hover:border-line-strong hover:text-ink"
      >
        <RefreshCw size={11} strokeWidth={2} aria-hidden="true" />
        Reintentar ahora
      </button>
    </div>
  );
};
