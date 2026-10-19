import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Asterisk,
  Columns2,
  Gauge,
  Hexagon,
  PanelLeft,
  Plus,
  Radio,
  Rows2,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { actions, AGENTS } from "../lib/actions";
import { cn, tabLabel } from "../lib/layout";
import { shortcutLabel, tabShortcutLabel, type ShortcutId } from "../lib/shortcuts";
import { Kbd } from "./ui";

interface Command {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: LucideIcon;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

const normalize = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const sc = (id: ShortcutId) => shortcutLabel(id);

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;
  return <PaletteDialog onClose={onClose} />;
};

const PaletteDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isBroadcastEnabled = useTerminalStore((s) => s.isBroadcastEnabled);
  const isSidebarOpen = useTerminalStore((s) => s.isSidebarOpen);

  const commands = useMemo<Command[]>(
    () => [
      { id: "new-tab", group: "Sesión", title: "Nueva pestaña", icon: Plus, shortcut: sc("newTab"), run: actions.newTab },
      { id: "split-right", group: "Sesión", title: "Dividir a la derecha", icon: Columns2, shortcut: sc("splitRight"), run: actions.splitRight },
      { id: "split-down", group: "Sesión", title: "Dividir hacia abajo", icon: Rows2, shortcut: sc("splitDown"), run: actions.splitDown },
      { id: "next-pane", group: "Sesión", title: "Panel siguiente", icon: ArrowRight, shortcut: sc("nextPane"), run: () => actions.focusPaneOffset(1) },
      { id: "prev-pane", group: "Sesión", title: "Panel anterior", icon: ArrowLeft, shortcut: sc("prevPane"), run: () => actions.focusPaneOffset(-1) },
      { id: "close-pane", group: "Sesión", title: "Cerrar panel", icon: X, shortcut: sc("closePane"), run: actions.closePane },

      { id: "claude-split", group: "Agentes", title: `${AGENTS.claude.title} junto al panel`, hint: "dividir", icon: Asterisk, run: () => actions.openAgentInSplit("claude") },
      { id: "claude-tab", group: "Agentes", title: `${AGENTS.claude.title} en pestaña nueva`, icon: Asterisk, run: () => actions.openAgentInTab("claude") },
      { id: "codex-split", group: "Agentes", title: `${AGENTS.codex.title} junto al panel`, hint: "dividir", icon: Hexagon, run: () => actions.openAgentInSplit("codex") },
      { id: "codex-tab", group: "Agentes", title: `${AGENTS.codex.title} en pestaña nueva`, icon: Hexagon, run: () => actions.openAgentInTab("codex") },

      { id: "sidebar", group: "Vista", title: isSidebarOpen ? "Ocultar sesiones" : "Mostrar sesiones", icon: PanelLeft, shortcut: sc("toggleSidebar"), run: actions.toggleSidebar },
      { id: "usage", group: "Vista", title: "Cuotas de IA", hint: "Claude · Codex", icon: Gauge, shortcut: sc("toggleUsage"), run: actions.toggleUsage },
      {
        id: "broadcast",
        group: "Vista",
        title: isBroadcastEnabled ? "Desactivar broadcast" : "Activar broadcast",
        hint: "escribir en todos los paneles",
        icon: Radio,
        shortcut: sc("toggleBroadcast"),
        run: actions.toggleBroadcast,
      },

      ...tabs.map<Command>((tab, index) => ({
        id: `tab-${tab.id}`,
        group: "Pestañas",
        title: tabLabel(tab),
        hint: tab.id === activeTabId ? "actual" : undefined,
        icon: SquareTerminal,
        shortcut: tabShortcutLabel(index),
        run: () => actions.goToTab(index),
      })),
    ],
    [tabs, activeTabId, isBroadcastEnabled, isSidebarOpen],
  );

  const filtered = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return commands;
    return commands.filter((cmd) => {
      const haystack = normalize(`${cmd.title} ${cmd.group} ${cmd.hint ?? ""}`);
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);

  const activeIndex = Math.min(selected, Math.max(filtered.length - 1, 0));
  const optionId = (index: number) => `${listId}-opt-${index}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const execute = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const count = filtered.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (count) setSelected((activeIndex + 1) % count);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (count) setSelected((activeIndex - 1 + count) % count);
        break;
      case "Enter":
        e.preventDefault();
        execute(filtered[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  let lastGroup = "";

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[14vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        className="flex w-full max-w-[560px] animate-pop-in flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)]"
      >
        <div className="flex h-12 items-center gap-3 border-b border-line px-4">
          <span className="font-mono text-[15px] text-amber" aria-hidden="true">
            ›
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={filtered.length ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Escribe un comando, agente o pestaña…"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 select-text bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Comandos" className="max-h-[min(400px,55vh)] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-ink-3">
              Nada coincide con «{query}».
            </p>
          ) : (
            filtered.map((cmd, index) => {
              const Icon = cmd.icon;
              const isSelected = index === activeIndex;
              const showGroup = cmd.group !== lastGroup;
              lastGroup = cmd.group;

              return (
                <React.Fragment key={cmd.id}>
                  {showGroup && (
                    <div
                      role="presentation"
                      className="px-2.5 pb-1 pt-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 first:pt-1"
                    >
                      {cmd.group}
                    </div>
                  )}
                  <div
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    data-index={index}
                    onMouseMove={() => {
                      if (!isSelected) setSelected(index);
                    }}
                    onClick={() => execute(cmd)}
                    className={cn(
                      "relative flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5",
                      isSelected ? "bg-hover text-ink" : "text-ink-2",
                    )}
                  >
                    {isSelected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-amber" aria-hidden="true" />}
                    <Icon
                      size={15}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className={cn("shrink-0", isSelected ? "text-amber" : "text-ink-3")}
                    />
                    <span className={cn("min-w-0 truncate text-[13px]", cmd.group === "Pestañas" && "font-mono text-[12px]")}>
                      {cmd.title}
                    </span>
                    {cmd.hint && <span className="shrink-0 truncate text-[12px] text-ink-3">{cmd.hint}</span>}
                    <span className="flex-1" />
                    {cmd.shortcut && <Kbd className={isSelected ? "text-ink-2" : undefined}>{cmd.shortcut}</Kbd>}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="flex h-8 items-center gap-4 border-t border-line px-4 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> navegar
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> ejecutar
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd> cerrar
          </span>
        </div>
      </div>
    </div>
  );
};
