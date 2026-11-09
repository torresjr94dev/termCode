import React, { useEffect, useMemo, useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Copy, FolderOpen, SquarePen, X, XCircle } from "lucide-react";
import { useProjectStore } from "../../../store/projectStore";
import { useUiStore } from "../../../store/uiStore";
import { absolutePath, closeFileTabs, openFile, openInEditor } from "../../../lib/project";
import { IS_TAURI } from "../../../lib/ipc";
import { cn } from "../../../lib/layout";
import { showContextMenu } from "../../ContextMenu";
import { revealLabel } from "../../../lib/platformLabels";

/** Las pestañas del visor (archivos abiertos en este proyecto). */
export const FileTabs: React.FC<{ root: string; active: string }> = ({ root, active }) => {
  const all = useProjectStore((s) => s.fileTabs);
  const tabs = useMemo(() => all.filter((t) => t.root === root), [all, root]);
  const strip = useRef<HTMLDivElement | null>(null);

  // La activa siempre a la vista (al abrir una nueva desde ⌘P queda al final).
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  if (!tabs.length) return null;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      useUiStore.getState().showToast("Ruta copiada.");
    } catch {
      useUiStore.getState().showToast("No se pudo copiar la ruta.", "error");
    }
  };

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Archivos abiertos"
      className="scrollbar-none flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-line bg-chrome px-1.5"
    >
      {tabs.map((tab) => {
        const selected = tab.path === active;
        const slash = tab.path.lastIndexOf("/");
        const name = tab.path.slice(slash + 1);
        const others = tabs.filter((t) => t.path !== tab.path).map((t) => t.path);
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={tab.path}
            onClick={() => !selected && void openFile(tab.path)}
            onAuxClick={(e) => {
              // Clic central: cerrar, como en el navegador.
              if (e.button === 1) void closeFileTabs([tab.path]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void openFile(tab.path);
              }
            }}
            onContextMenu={(e) => {
              const abs = absolutePath(tab.path);
              showContextMenu(e, `Pestaña ${name}`, [
                { label: "Cerrar", icon: X, onSelect: () => void closeFileTabs([tab.path]) },
                { label: "Cerrar las demás", icon: XCircle, disabled: !others.length, onSelect: () => void closeFileTabs(others) },
                { label: "Cerrar todas", onSelect: () => void closeFileTabs(tabs.map((t) => t.path)) },
                "separator",
                { label: "Abrir en tu editor", icon: SquarePen, onSelect: () => void openInEditor(tab.path) },
                { label: "Copiar ruta", icon: Copy, disabled: !abs, onSelect: () => abs && void copy(abs) },
                { label: "Copiar ruta relativa", onSelect: () => void copy(tab.path) },
                ...(IS_TAURI && abs ? [{ label: revealLabel(), icon: FolderOpen, onSelect: () => void revealItemInDir(abs).catch(() => {}) }] : []),
              ]);
            }}
            className={cn(
              "group relative flex h-8 min-w-0 max-w-[220px] shrink-0 cursor-default select-none items-center gap-1.5 rounded-t-md pl-3 pr-1 font-mono text-[12px] transition-colors duration-150",
              selected ? "bg-canvas text-ink shadow-[inset_0_1.5px_0_var(--color-accent)]" : "text-ink-3 hover:bg-hover hover:text-ink-2",
            )}
          >
            <span className="min-w-0 truncate">{name}</span>
            <button
              type="button"
              aria-label={tab.dirty ? `Cerrar ${name} (sin guardar)` : `Cerrar ${name}`}
              title={tab.dirty ? "Sin guardar · cerrar" : "Cerrar"}
              onClick={(e) => {
                e.stopPropagation();
                void closeFileTabs([tab.path]);
              }}
              className="grid size-5 shrink-0 place-items-center rounded text-ink-3 hover:bg-press hover:text-ink"
            >
              {tab.dirty ? (
                <>
                  <span aria-hidden="true" className="size-2 rounded-full bg-accent group-hover:hidden" />
                  <X size={12} strokeWidth={2} aria-hidden="true" className="hidden group-hover:block" />
                </>
              ) : (
                <X size={12} strokeWidth={2} aria-hidden="true" className={cn(!selected && "opacity-0 group-hover:opacity-100")} />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
};
