import React from "react";
import { Asterisk, Hexagon, PanelLeft, Plus, Search, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { actions } from "../lib/actions";
import { cn, findPane, tabLabel } from "../lib/layout";
import { IS_MAC, shortcutLabel, tabShortcutLabel } from "../lib/shortcuts";
import { IconButton, Kbd, agentIcon } from "./ui";

interface HeaderProps {
  onOpenPalette: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenPalette }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isSidebarOpen = useTerminalStore((s) => s.isSidebarOpen);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const closeTab = useTerminalStore((s) => s.closeTab);

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
            const AgentIcon = agentIcon(findPane(tab.root, tab.activePaneId)?.agentType);
            const hint = tabShortcutLabel(index);

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
                    if (e.button === 1 && canClose) closeTab(tab.id);
                  }}
                  className="flex h-full min-w-0 items-center gap-2 pl-3 pr-1 outline-offset-[-2px]"
                >
                  <span
                    className={cn(
                      "font-mono text-[11px] tabular-nums",
                      isActive ? "text-amber" : "text-ink-3",
                    )}
                  >
                    {index + 1}
                  </span>
                  <AgentIcon size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 opacity-80" />
                  <span className="max-w-[180px] truncate font-mono text-[12px]">{label}</span>
                </button>

                {canClose ? (
                  <button
                    type="button"
                    aria-label={`Cerrar pestaña ${label}`}
                    onClick={() => closeTab(tab.id)}
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

const UsageButton: React.FC = () => {
  const claude = useTerminalStore((s) => s.aiUsage.claude.fiveHour.usedPercent);
  const codex = useTerminalStore((s) => s.aiUsage.chatgpt.primary5h.usedPercent);
  const isOpen = useTerminalStore((s) => s.isUsageDrawerOpen);

  const readings = [
    { icon: Asterisk, name: "Claude", value: claude },
    { icon: Hexagon, name: "Codex", value: codex },
  ];

  return (
    <button
      type="button"
      onClick={actions.toggleUsage}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-label={`Cuotas de IA: Claude ${claude}%, Codex ${codex}%`}
      title={`Cuotas de IA  ${shortcutLabel("toggleUsage")}`}
      className={cn(
        "flex h-7 items-center gap-3 rounded-md border px-2.5 font-mono text-[12px] tabular-nums transition-colors duration-150",
        isOpen
          ? "border-line-strong bg-press text-ink"
          : "border-line text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink",
      )}
    >
      {readings.map(({ icon: Icon, name, value }) => (
        <span key={name} className="flex items-center gap-1.5">
          <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
          <span className={value >= 85 ? "text-signal" : undefined}>{value}%</span>
        </span>
      ))}
    </button>
  );
};
