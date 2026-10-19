import React from "react";
import { Asterisk, GitBranch, Hexagon, PanelLeft, Plus, Search, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { useProjectStore } from "../store/projectStore";
import { openProject } from "../lib/project";
import { actions } from "../lib/actions";
import { cn, collectPanes, findPane, tabLabel } from "../lib/layout";
import { IS_MAC, shortcutLabel, tabShortcutLabel } from "../lib/shortcuts";
import type { ProviderUsage } from "../types/layout";
import { AgentGlyph, IconButton, Kbd, Lamp } from "./ui";

interface HeaderProps {
  onOpenPalette: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenPalette }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isSidebarOpen = useTerminalStore((s) => s.isSidebarOpen);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const attention = useTerminalStore((s) => s.attention);

  const canClose = tabs.length > 1;

  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-10 shrink-0 items-stretch bg-chrome pr-2 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-line"
    >
      {/* Hueco para los semáforos de macOS (solo cuando la barra lateral no los aloja) */}
      {IS_MAC && !isSidebarOpen && <div data-tauri-drag-region className="w-[84px] shrink-0" />}

      <div className={cn("flex items-center", !(IS_MAC && !isSidebarOpen) && "pl-2")}>
        <IconButton
          icon={PanelLeft}
          label={isSidebarOpen ? "Ocultar sesiones" : "Mostrar sesiones"}
          shortcut={shortcutLabel("toggleSidebar")}
          pressed={isSidebarOpen}
          onClick={actions.toggleSidebar}
        />
      </div>

      <nav aria-label="Pestañas" className="ml-2 flex min-w-0 items-end">
        <ul data-tauri-drag-region className="scrollbar-none flex min-w-0 items-end gap-0.5 overflow-x-auto">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const label = tabLabel(tab);
            const agentType = findPane(tab.root, tab.activePaneId)?.agentType;
            const hint = tabShortcutLabel(index);
            const needsAttention = collectPanes(tab.root).some((p) => p.id in attention);

            return (
              <li
                key={tab.id}
                className={cn(
                  "group relative flex h-[31px] shrink-0 items-center rounded-t-md border-x border-t transition-colors duration-150",
                  isActive
                    ? "z-10 border-line bg-canvas text-ink"
                    : "border-transparent text-ink-3 hover:bg-hover/60 hover:text-ink-2",
                )}
              >
                <button
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  title={hint ? `${label}  ${hint}` : label}
                  onClick={() => setActiveTab(tab.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && canClose) actions.closeTab(tab.id);
                  }}
                  className="flex h-full min-w-0 items-center gap-2 pl-3 pr-1 outline-offset-[-2px]"
                >
                  {needsAttention ? (
                    <Lamp state="attention" />
                  ) : (
                    <span
                      className={cn(
                        "font-mono text-[11px] tabular-nums",
                        isActive ? "text-amber" : "text-ink-3",
                      )}
                    >
                      {index + 1}
                    </span>
                  )}
                  <AgentGlyph agentType={agentType} className="shrink-0 opacity-80" />
                  <span className="max-w-[180px] truncate font-mono text-[12px]">{label}</span>
                </button>

                {canClose ? (
                  <button
                    type="button"
                    aria-label={`Cerrar pestaña ${label}`}
                    onClick={() => actions.closeTab(tab.id)}
                    className={cn(
                      "mr-1.5 grid size-5 place-items-center rounded text-ink-3 transition-opacity duration-150 hover:bg-press hover:text-ink focus-visible:opacity-100",
                      isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                  >
                    <X size={12} strokeWidth={2} aria-hidden="true" />
                  </button>
                ) : (
                  <span className="w-2" />
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex h-[31px] items-center pl-1">
          <IconButton icon={Plus} label="Nueva pestaña" shortcut={shortcutLabel("newTab")} onClick={actions.newTab} />
        </div>
      </nav>

      <div data-tauri-drag-region className="min-w-4 flex-1" />

      <div className="flex items-center gap-1.5">
        <BranchButton />
        <UsageButton />
        <button
          type="button"
          onClick={onOpenPalette}
          title={`Comandos  ${shortcutLabel("palette")}`}
          className="flex h-7 items-center gap-2 rounded-md border border-line px-2.5 text-ink-2 transition-colors duration-150 hover:border-line-strong hover:bg-hover hover:text-ink"
        >
          <Search size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="hidden text-[12px] md:inline">Comandos</span>
          <Kbd>{shortcutLabel("palette")}</Kbd>
        </button>
      </div>
    </header>
  );
};

/** Lectura principal de un proveedor para el botón: la ventana de sesión. */
function headline(provider: ProviderUsage): { text: string; critical: boolean; spoken: string } {
  if (provider.authMode === "api-key") return { text: "API", critical: false, spoken: "API key" };
  const session = provider.windows.find((w) => w.kind === "session") ?? provider.windows[0];
  if (!session) {
    const text = provider.status === "loading" ? "…" : "—";
    return { text, critical: false, spoken: provider.status === "loading" ? "cargando" : "sin datos" };
  }
  const pct = Math.round(session.usedPercent);
  return { text: `${pct}%`, critical: pct >= 85, spoken: `${pct}%` };
}

const UsageButton: React.FC = () => {
  const usage = useTerminalStore((s) => s.usage);
  const isOpen = useTerminalStore((s) => s.isUsageDrawerOpen);

  const readings = [
    { icon: Asterisk, name: "Claude", ...headline(usage.claude) },
    { icon: Hexagon, name: "Codex", ...headline(usage.codex) },
  ];

  return (
    <button
      type="button"
      onClick={actions.toggleUsage}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-label={`Cuotas de IA: ${readings.map((r) => `${r.name} ${r.spoken}`).join(", ")}`}
      title={`Cuotas de IA  ${shortcutLabel("toggleUsage")}`}
      className={cn(
        "flex h-7 items-center gap-3 rounded-md border px-2.5 font-mono text-[12px] tabular-nums transition-colors duration-150",
        isOpen
          ? "border-line-strong bg-press text-ink"
          : "border-line text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink",
      )}
    >
      {readings.map(({ icon: Icon, name, text, critical }) => (
        <span key={name} className="flex items-center gap-1.5">
          <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
          <span className={critical ? "text-signal" : undefined}>{text}</span>
        </span>
      ))}
    </button>
  );
};

/** Rama del repo donde está el panel activo; abre la vista de cambios. */
const BranchButton: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const status = useProjectStore((s) => s.status);
  const isOpen = useProjectStore((s) => s.isOpen && s.tab === "changes");
  if (!repo || !status) return null;

  const branch = status.branch ?? (status.head ? `@${status.head.slice(0, 7)}` : "sin commits");
  const changes = status.changes.length;
  const sync = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      onClick={() => openProject("changes")}
      aria-pressed={isOpen}
      aria-label={`Rama ${branch}${changes ? `, ${changes} cambios` : ""}`}
      title={`${repo.name} · ${branch}  ${shortcutLabel("projectChanges")}`}
      className={cn(
        "flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border px-2.5 font-mono text-[12px] transition-colors duration-150",
        isOpen
          ? "border-line-strong bg-press text-ink"
          : "border-line text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink",
      )}
    >
      <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="truncate">{branch}</span>
      {changes > 0 && <span className="shrink-0 tabular-nums text-amber">●{changes}</span>}
      {sync && <span className="shrink-0 tabular-nums text-ink-3">{sync}</span>}
    </button>
  );
};
