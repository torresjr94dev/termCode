import React from "react";
import { Asterisk, Hexagon, SquareTerminal, type LucideIcon } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { actions, AGENTS } from "../lib/actions";
import { cn, collectPanes, tabLabel } from "../lib/layout";
import { IS_MAC, shortcutLabel, tabShortcutLabel } from "../lib/shortcuts";
import { Kbd, Lamp, SectionLabel } from "./ui";

export const Sidebar: React.FC = () => {
  const isOpen = useTerminalStore((s) => s.isSidebarOpen);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);

  if (!isOpen) return null;

  return (
    <aside
      aria-label="Sesiones"
      className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-chrome"
    >
      {/* Zona de arrastre: aquí viven los semáforos de macOS */}
      <div data-tauri-drag-region className={cn("shrink-0", IS_MAC ? "h-10" : "h-2")} />

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-3 pt-2">
        <section>
          <SectionLabel aside={tabs.length}>Sesiones</SectionLabel>
          <ul className="flex flex-col gap-px px-1.5">
            {tabs.map((tab, index) => {
              const isActiveTab = tab.id === activeTabId;
              const panes = collectPanes(tab.root);
              const label = tabLabel(tab);

              return (
                <li key={tab.id}>
                  <button
                    type="button"
                    aria-current={isActiveTab ? "page" : undefined}
                    title={tabShortcutLabel(index) ? `${label}  ${tabShortcutLabel(index)}` : label}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "flex h-8 w-full items-center gap-2.5 rounded-md px-1.5 text-left transition-colors duration-150",
                      isActiveTab ? "bg-press text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
                    )}
                  >
                    <span
                      className={cn(
                        "w-4 text-center font-mono text-[11px] tabular-nums",
                        isActiveTab ? "text-amber" : "text-ink-3",
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{label}</span>
                  </button>

                  {panes.length > 1 && (
                    <ul className="mb-1 ml-[25px] mt-px flex flex-col gap-px border-l border-line pl-1.5">
                      {panes.map((pane) => {
                        const isFocused = pane.id === tab.activePaneId;
                        return (
                          <li key={pane.id}>
                            <button
                              type="button"
                              onClick={() => actions.focusPane(tab.id, pane.id)}
                              className={cn(
                                "flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors duration-150",
                                isFocused ? "text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
                              )}
                            >
                              <Lamp state={isFocused ? (isActiveTab ? "on" : "idle") : "off"} />
                              <span className="min-w-0 truncate font-mono text-[12px]">{pane.title}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <SectionLabel>Nueva pestaña</SectionLabel>
          <ul className="flex flex-col gap-px px-1.5">
            <LaunchRow icon={SquareTerminal} title="Shell" detail="Tu shell de inicio" shortcut={shortcutLabel("newTab")} onClick={actions.newTab} />
            <LaunchRow
              icon={Asterisk}
              title={AGENTS.claude.title}
              detail={AGENTS.claude.vendor}
              onClick={() => actions.openAgentInTab("claude")}
            />
            <LaunchRow
              icon={Hexagon}
              title={AGENTS.codex.title}
              detail={AGENTS.codex.vendor}
              onClick={() => actions.openAgentInTab("codex")}
            />
          </ul>
        </section>
      </div>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-line px-3 text-[12px] text-ink-3">
        <span>Todos los comandos</span>
        <Kbd>{shortcutLabel("palette")}</Kbd>
      </div>
    </aside>
  );
};

interface LaunchRowProps {
  icon: LucideIcon;
  title: string;
  detail: string;
  shortcut?: string;
  onClick: () => void;
}

const LaunchRow: React.FC<LaunchRowProps> = ({ icon: Icon, title, detail, shortcut, onClick }) => (
  <li>
    <button
      type="button"
      onClick={onClick}
      className="group flex h-10 w-full items-center gap-2.5 rounded-md px-1.5 text-left text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded border border-line text-ink-3 transition-colors duration-150 group-hover:border-amber/50 group-hover:text-amber">
        <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px]">{title}</span>
        <span className="truncate text-[11px] text-ink-3">{detail}</span>
      </span>
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </button>
  </li>
);
