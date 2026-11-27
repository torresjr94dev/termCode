import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRightLeft,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Group,
  Maximize2,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Ungroup,
  X,
} from "lucide-react";
import { ClaudeCodeLogo, CodexLogo } from "./agentLogos";
import { usePaneAgent, useTerminalStore } from "../store/terminalStore";
import { useProjectStore } from "../store/projectStore";
import { useApprovalStore } from "../store/approvalStore";
import { openBranchPicker } from "../lib/project";
import { BranchPicker } from "./project/BranchPicker";
import { HeaderFestive, SantaHat, useFestive } from "./festive/Festive";
import { actions } from "../lib/actions";
import { basename, cn, collectPanes, findPane } from "../lib/layout";
import { projectColor, shortCommand, tabDisplayName } from "../lib/identity";
import { attentionCandidates } from "../lib/attention";
import { useRunningCommand } from "../terminal/useRunningCommand";
import { IS_WINDOWS, shortcutLabel, tabShortcutLabel } from "../lib/shortcuts";
import type { ProviderUsage, Tab, TabGroup } from "../types/layout";
import { terminalManager } from "../terminal/TerminalManager";
import { AgentGlyph, IconButton, Kbd, Lamp, Ring } from "./ui";
import { WindowControls } from "./WindowControls";
import { pace } from "../lib/quota";
import { useNow } from "../lib/useNow";
import { useSettingsStore } from "../store/settingsStore";
import { tildify } from "../lib/paths";
import { useTrafficLights } from "../lib/fullscreen";
import { GROUP_COLORS, GROUP_COLOR_NAMES, groupColorVar, stripItems, type TabDrop } from "../lib/tabGroups";
import { showContextMenu } from "./ContextMenu";
import { useUiStore, type MenuItem } from "../store/uiStore";

interface HeaderProps {
  onOpenPalette: () => void;
}

/** Lo que se arrastra en la tira: una pestaña o un grupo entero (por su cápsula). */
type StripDrag =
  | { kind: "tab"; tabId: string; drop: TabDrop | null }
  | { kind: "group"; groupId: string; before: string | null | undefined };

/** Umbral para que un clic no se vuelva arrastre. */
const DRAG_THRESHOLD = 5;

/**
 * Dónde caería una pestaña con el puntero en `x`. Sobre el tercio central de
 * otra pestaña se agrupan; en sus bordes se pone al lado. Sobre una cápsula:
 * su borde izquierdo queda fuera del grupo, el resto entra.
 */
function tabDropAt(list: HTMLElement, x: number, draggedId: string): TabDrop | null {
  for (const el of list.querySelectorAll<HTMLElement>("[data-slot]")) {
    const r = el.getBoundingClientRect();
    if (x > r.right) continue;
    const rel = (x - r.left) / Math.max(r.width, 1);
    if (el.dataset.slot === "chip") {
      const groupId = el.dataset.groupId ?? "";
      return rel < 0.35 ? { kind: "chip-before", groupId } : { kind: "chip-into", groupId };
    }
    const targetId = el.dataset.tabId ?? "";
    if (targetId === draggedId) return null;
    if (rel < 0.3) return { kind: "before", targetId };
    if (rel > 0.7) return { kind: "after", targetId };
    return { kind: "onto", targetId };
  }
  return { kind: "end" };
}

/**
 * Antes de qué pestaña cae un grupo arrastrado (`null`: al final; `undefined`:
 * donde ya estaba). Solo cuentan las pestañas sueltas y las cápsulas.
 */
function groupDropAt(list: HTMLElement, x: number, groupId: string): string | null | undefined {
  for (const el of list.querySelectorAll<HTMLElement>("[data-top]")) {
    if (el.dataset.groupId === groupId && el.dataset.slot === "chip") continue;
    const r = el.getBoundingClientRect();
    if (x < r.left + r.width / 2) return el.dataset.top;
  }
  return null;
}

export const Header: React.FC<HeaderProps> = ({ onOpenPalette }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const groups = useTerminalStore((s) => s.groups);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const isSidebarOpen = useTerminalStore((s) => s.isSidebarOpen);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const attention = useTerminalStore((s) => s.attention);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Hueco para los semáforos de macOS: solo con la ventana normal y sin barra lateral (que los aloja).
  const lightsGap = useTrafficLights() && !isSidebarOpen;
  const [drag, setDrag] = useState<StripDrag | null>(null);
  /** Grupo con su editor abierto (nombre, color, acciones). */
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const closeEditor = useCallback(() => setEditingGroup(null), []);
  const items = useMemo(() => stripItems(tabs, groups), [tabs, groups]);
  /** Soltar un arrastre sobre la propia cápsula no debe contar como clic (plegaría el grupo). */
  const justDragged = useRef(false);

  /** Sigue el puntero con umbral; `onUp` decide qué hacer si hubo arrastre. */
  const track = (e: React.PointerEvent, onMove: (x: number) => void, onUp: () => void) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;
      dragging = true;
      onMove(ev.clientX);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!dragging) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      onUp();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** Arrastrar una pestaña: la reordena, la mete o saca de un grupo, o crea uno. */
  const startTabDrag = (tabId: string, e: React.PointerEvent) => {
    let current: StripDrag = { kind: "tab", tabId, drop: null };
    track(
      e,
      (x) => {
        const list = listRef.current;
        if (!list) return;
        current = { kind: "tab", tabId, drop: tabDropAt(list, x, tabId) };
        setDrag(current);
      },
      () => {
        setDrag(null);
        if (current.kind !== "tab" || !current.drop) return;
        const created = useTerminalStore.getState().dropTab(tabId, current.drop);
        // Grupo recién nacido: se le pone nombre y color en el momento.
        if (created) setEditingGroup(created);
      },
    );
  };

  /** Arrastrar la cápsula mueve el grupo entero. */
  const startGroupDrag = (groupId: string, e: React.PointerEvent) => {
    let current: StripDrag = { kind: "group", groupId, before: undefined };
    track(
      e,
      (x) => {
        const list = listRef.current;
        if (!list) return;
        current = { kind: "group", groupId, before: groupDropAt(list, x, groupId) };
        setDrag(current);
      },
      () => {
        setDrag(null);
        if (current.kind === "group" && current.before !== undefined) {
          useTerminalStore.getState().moveGroup(groupId, current.before);
        }
      },
    );
  };

  const groupOf = (tabId: string) => tabs.find((t) => t.id === tabId)?.groupId;
  /** Marca de dónde cae lo arrastrado, para la pestaña o la cápsula que la lleva. */
  const tabHint = (tabId: string): TabDropHint | null => {
    if (drag?.kind === "group") return drag.before === tabId && !groupOf(tabId) ? { side: "before", color: null } : null;
    const drop = drag?.drop;
    if (!drop || !("targetId" in drop) || drop.targetId !== tabId) return null;
    const joins = groupOf(tabId);
    const color = joins ? groupColorVar(groups.find((g) => g.id === joins)?.color ?? "gris") : null;
    return { side: drop.kind, color };
  };
  const chipHint = (group: TabGroup, firstTabId: string): "before" | "into" | null => {
    if (drag?.kind === "group") return drag.before === firstTabId && drag.groupId !== group.id ? "before" : null;
    const drop = drag?.drop;
    if (!drop || !("groupId" in drop) || drop.groupId !== group.id) return null;
    return drop.kind === "chip-before" ? "before" : "into";
  };
  const dropAtEnd = drag?.kind === "tab" ? drag.drop?.kind === "end" : drag?.kind === "group" && drag.before === null;

  const canClose = tabs.length > 1;

  return (
    <header
      data-tauri-drag-region
      data-chrome
      // En Windows la ventana no tiene marco: esta es la barra de título y los
      // botones de ventana van pegados al borde derecho.
      className={cn("relative z-20 flex h-11 shrink-0 items-center bg-chrome", IS_WINDOWS ? "pr-0" : "pr-2")}
    >
      {lightsGap && <div data-tauri-drag-region className="h-full w-[78px] shrink-0" />}

      <div className={cn("flex items-center", !lightsGap && "pl-2")}>
        <IconButton
          icon={PanelLeft}
          label={isSidebarOpen ? "Ocultar sesiones" : "Mostrar sesiones"}
          shortcut={shortcutLabel("toggleSidebar")}
          pressed={isSidebarOpen}
          onClick={actions.toggleSidebar}
        />
        <AttentionBell />
      </div>

      <nav aria-label="Pestañas" className="ml-1.5 flex min-w-0 items-center">
        <ul ref={listRef} data-tauri-drag-region className="scrollbar-none flex min-w-0 items-center gap-0.5 overflow-x-auto py-1">
          {items.map((item) => {
            const renderTab = ({ tab, index }: { tab: Tab; index: number }, group?: TabGroup, last?: boolean) => (
              <TabItem
                key={tab.id}
                tab={tab}
                index={index}
                group={group}
                lastInGroup={last}
                isActive={tab.id === activeTabId}
                canClose={canClose}
                needsAttention={collectPanes(tab.root).some((p) => p.id in attention)}
                dropHint={tabHint(tab.id)}
                isDragged={
                  drag?.kind === "tab"
                    ? drag.tabId === tab.id && drag.drop !== null
                    : drag?.kind === "group" && drag.before !== undefined && drag.groupId === group?.id
                }
                onPointerDownTab={(e) => startTabDrag(tab.id, e)}
                onSelect={() => setActiveTab(tab.id)}
                onEditGroup={setEditingGroup}
              />
            );
            if (item.kind === "tab") return renderTab(item);
            const { group, tabs: members } = item;
            return (
              <React.Fragment key={group.id}>
                <GroupChip
                  group={group}
                  count={members.length}
                  firstTabId={members[0].tab.id}
                  needsAttention={members.some(({ tab }) => collectPanes(tab.root).some((p) => p.id in attention))}
                  dropHint={chipHint(group, members[0].tab.id)}
                  isDragged={drag?.kind === "group" && drag.groupId === group.id && drag.before !== undefined}
                  isEditing={editingGroup === group.id}
                  onPointerDownChip={(e) => startGroupDrag(group.id, e)}
                  onToggle={() => {
                    if (!justDragged.current) actions.toggleGroup(group.id);
                  }}
                  onEdit={() => setEditingGroup(group.id)}
                />
                {!group.collapsed && members.map((m, i) => renderTab(m, group, i === members.length - 1))}
              </React.Fragment>
            );
          })}
          {dropAtEnd && (
            <li aria-hidden="true" className="relative h-[30px] w-0 shrink-0">
              <span className="absolute inset-y-1 -left-1 w-0.5 rounded-full bg-accent" />
            </li>
          )}
        </ul>
        {editingGroup && <GroupEditor key={editingGroup} groupId={editingGroup} onClose={closeEditor} />}

        <div className="flex items-center pl-1">
          <IconButton icon={Plus} label="Nueva pestaña" shortcut={shortcutLabel("newTab")} onClick={actions.newTab} />
          <ShellMenu />
        </div>
      </nav>

      <div data-tauri-drag-region className="@container relative min-w-4 flex-1 self-stretch">
        <HeaderFestive />
      </div>

      <div className="flex items-center gap-1.5">
        <BranchButton />
        <UsageButton />
        <button
          type="button"
          onClick={onOpenPalette}
          title={`Comandos  ${shortcutLabel("palette")}`}
          className="glass-pill flex h-[30px] items-center gap-2 rounded-[10px] px-3 text-ink-2 transition-colors duration-150 hover:text-ink"
        >
          <Search size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="hidden text-[12px] md:inline">Comandos</span>
          <Kbd>{shortcutLabel("palette")}</Kbd>
        </button>
        <IconButton icon={Settings} label="Ajustes" shortcut={shortcutLabel("settings")} onClick={actions.openSettings} />
      </div>
      {IS_WINDOWS && (
        <div className="ml-2 flex h-full">
          <WindowControls />
        </div>
      )}
    </header>
  );
};

/**
 * Lo que te espera en otros paneles, lo mismo que atiende ⌘J: agentes que
 * piden permiso o preguntan (acento) y comandos que terminaron o fallaron.
 */
const AttentionBell: React.FC = () => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const attention = useTerminalStore((s) => s.attention);
  const activity = useTerminalStore((s) => s.agentActivity);
  const approvals = useApprovalStore((s) => s.requests);
  const current = tabs.find((t) => t.id === activeTabId)?.activePaneId;
  const pending = attentionCandidates(tabs, attention, activity, current, approvals);
  const urgent = pending.some((c) => c.rank === 0);
  const label = pending.length
    ? `${pending.length} ${pending.length === 1 ? "panel te espera" : "paneles te esperan"}`
    : "Nadie te espera";

  return (
    <button
      type="button"
      onClick={actions.focusNextAttention}
      aria-label={label}
      title={`${label}  ${shortcutLabel("nextAttention")}`}
      className="relative grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
    >
      <Bell size={15} strokeWidth={1.75} aria-hidden="true" />
      {pending.length > 0 && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full px-1 font-mono text-[9.5px] font-semibold leading-none tabular-nums",
            urgent ? "bg-accent text-on-accent" : "bg-press text-ink-2",
          )}
        >
          {pending.length}
        </span>
      )}
    </button>
  );
};

/** Lectura principal de un proveedor para el botón: la ventana de sesión, con su ritmo. */
function headline(provider: ProviderUsage, now: number) {
  if (provider.authMode === "api-key") return { text: "API", value: null, elapsed: null, spoken: "API key (sin ventanas)" };
  const session = provider.windows.find((w) => w.kind === "session") ?? provider.windows[0];
  if (!session) {
    const text = provider.status === "loading" ? "…" : "—";
    return { text, value: null, elapsed: null, spoken: provider.status === "loading" ? "cargando" : "sin datos" };
  }
  const pct = Math.round(session.usedPercent);
  const p = pace(session, now);
  return { text: `${pct}%`, value: pct, elapsed: p?.elapsedPercent ?? null, spoken: `${pct}% de la sesión de 5 h` };
}

const UsageButton: React.FC = () => {
  const usage = useTerminalStore((s) => s.usage);
  const isOpen = useTerminalStore((s) => s.isUsageDrawerOpen);
  const now = useNow(30_000);

  const readings = [
    { icon: ClaudeCodeLogo, name: "Claude", ...headline(usage.claude, now) },
    { icon: CodexLogo, name: "Codex", ...headline(usage.codex, now) },
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
        "flex h-[30px] items-center gap-3 rounded-[10px] px-2.5 font-mono text-[12px] tabular-nums transition-colors duration-150",
        isOpen ? "glass-pill text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
      )}
    >
      {readings.map(({ icon: Icon, name, text, value, elapsed }) => (
        <span key={name} className="flex items-center gap-1.5">
          {value === null ? (
            <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
          ) : (
            // Anillo exterior: lo usado. Interior: cuánto de la ventana ya pasó.
            <Ring value={value} inner={elapsed} size={18} stroke={2.25} />
          )}
          <span className={value !== null && value >= 90 ? "text-signal" : value !== null && value >= 75 ? "text-warn" : undefined}>
            {text}
          </span>
        </span>
      ))}
    </button>
  );
};

/**
 * Rama del repo donde está el panel activo. Es un selector: despliega las
 * ramas ahí mismo y cambiar es un `git switch` (si hay cambios sin commit,
 * antes pregunta qué hacer con ellos).
 */
const BranchButton: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const status = useProjectStore((s) => s.status);
  const isOpen = useProjectStore((s) => s.isBranchPickerOpen && s.branchPickerAt === "header");
  const busy = useProjectStore((s) => s.busy === "branch");
  if (!repo || !status) return null;

  const branch = status.branch ?? (status.head ? `@${status.head.slice(0, 7)}` : "sin commits");
  const changes = status.changes.length;
  const sync = [status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" ");

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => openBranchPicker("header")}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-busy={busy}
        aria-label={`Rama ${branch}${changes ? `, ${changes} cambios sin commit` : ""}. Cambiar de rama`}
        title={`${repo.name} · ${branch} · cambiar de rama  ${shortcutLabel("switchBranch")}`}
        className={cn(
          "flex h-[30px] max-w-[240px] items-center gap-1.5 rounded-[10px] px-2.5 font-mono text-[12px] transition-colors duration-150",
          isOpen ? "glass-pill text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
          busy && "opacity-60",
        )}
      >
        <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
        <span className="truncate">{branch}</span>
        {changes > 0 && <span className="shrink-0 tabular-nums text-accent">●{changes}</span>}
        {sync && <span className="shrink-0 tabular-nums text-ink-3">{sync}</span>}
        <ChevronDown
          size={11}
          strokeWidth={2.25}
          aria-hidden="true"
          className={cn("shrink-0 text-ink-3 transition-transform duration-150", isOpen && "rotate-180")}
        />
      </button>
      <BranchPicker at="header" />
    </div>
  );
};

/** Dónde caería lo arrastrado respecto a esta pestaña; `color`: el del grupo al que entraría. */
interface TabDropHint {
  side: "before" | "after" | "onto";
  color: string | null;
}

interface TabItemProps {
  tab: Tab;
  index: number;
  /** Grupo desplegado al que pertenece (lleva su línea de color debajo). */
  group?: TabGroup;
  lastInGroup?: boolean;
  isActive: boolean;
  canClose: boolean;
  needsAttention: boolean;
  dropHint: TabDropHint | null;
  isDragged: boolean;
  onPointerDownTab: (e: React.PointerEvent) => void;
  onSelect: () => void;
  onEditGroup: (groupId: string) => void;
}

const groupLabel = (g: TabGroup) => g.name || `Grupo ${GROUP_COLOR_NAMES[g.color].toLowerCase()}`;

/** Progreso que reporta el programa del panel activo (OSC 9;4). */
function useTabProgress(paneId: string): { state: number; value: number } {
  const snapshot = useSyncExternalStore(terminalManager.subscribeProgress, () => {
    const p = terminalManager.getProgress(paneId);
    return `${p.state}:${p.value}`;
  });
  const [state, value] = snapshot.split(":").map(Number);
  return { state, value };
}

const TabItem: React.FC<TabItemProps> = ({
  tab,
  index,
  group,
  lastInGroup,
  isActive,
  canClose,
  needsAttention,
  dropHint,
  isDragged,
  onPointerDownTab,
  onSelect,
  onEditGroup,
}) => {
  const renameTab = useTerminalStore((s) => s.renameTab);
  const paneProject = useTerminalStore((s) => s.paneProject);
  const groups = useTerminalStore((s) => s.groups);
  const festive = useFestive();
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const label = tabDisplayName(tab, paneProject);
  const project = paneProject[tab.activePaneId];
  const running = useRunningCommand(tab.activePaneId);
  // Si el nombre ya es el comando (p. ej. el título que puso vim), no se repite.
  const runningHint = running && !label.startsWith(running.split(" ")[0]) ? shortCommand(running, 2) : null;
  const pane = findPane(tab.root, tab.activePaneId);
  const agentType = usePaneAgent(pane);
  // Dónde está parada (dos «Claude Code» dejan de verse iguales); si el nombre ya es la carpeta, no se repite.
  const cwd = project?.cwd ?? pane?.cwd;
  const folder = cwd ? basename(cwd) : null;
  const folderHint = !runningHint && folder && folder !== label ? folder : null;
  const hint = tabShortcutLabel(index);
  const progress = useTabProgress(tab.activePaneId);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const finish = (save: boolean) => {
    if (save) renameTab(tab.id, inputRef.current?.value ?? "");
    setEditing(false);
  };

  /** Agrupar, mover a otro grupo, sacar, renombrar y cerrar. */
  const menu = (): MenuItem[] => {
    const store = useTerminalStore.getState();
    const others = groups.filter((g) => g.id !== tab.groupId).slice(0, 8);
    return [
      {
        label: "Añadir a grupo nuevo",
        icon: Group,
        onSelect: () => {
          const created = store.groupTab(tab.id);
          if (created) onEditGroup(created);
        },
      },
      ...others.map(
        (g): MenuItem => ({ label: `Mover a ${groupLabel(g)}`, icon: ArrowRightLeft, onSelect: () => store.joinGroup(tab.id, g.id) }),
      ),
      ...(tab.groupId ? [{ label: "Quitar del grupo", icon: Ungroup, onSelect: () => store.leaveGroup(tab.id) } satisfies MenuItem] : []),
      "separator",
      { label: "Renombrar pestaña", icon: Pencil, hint: "doble clic", onSelect: () => setEditing(true) },
      { label: "Cerrar pestaña", icon: X, disabled: !canClose, onSelect: () => actions.closeTab(tab.id) },
    ];
  };

  const groupColor = group ? groupColorVar(group.color) : null;

  return (
    <li
      data-index={index}
      data-slot="tab"
      data-tab-id={tab.id}
      // Las sueltas cuentan como posición al arrastrar un grupo entero.
      {...(group ? {} : { "data-top": tab.id })}
      onPointerDown={(e) => {
        if (!editing && !(e.target as HTMLElement).closest("[data-no-drag]")) onPointerDownTab(e);
      }}
      onContextMenu={(e) => showContextMenu(e, `Pestaña ${label}`, menu())}
      className={cn(
        // Cápsula de vidrio solo para la activa; el resto, texto que se ilumina al pasar.
        // Como en un navegador, con muchas pestañas se encogen (el nombre se corta)
        // antes de que la tira se desborde y esconda la activa.
        "group relative flex h-[30px] min-w-[64px] shrink items-center rounded-[10px] transition-[background-color,color,box-shadow] duration-150",
        isActive ? "glass-pill z-10 text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2",
        isDragged && "opacity-50",
      )}
      style={
        dropHint?.side === "onto"
          ? { boxShadow: `inset 0 0 0 1.5px ${dropHint.color ?? "var(--color-accent)"}` }
          : undefined
      }
    >
      {festive && isActive && <SantaHat />}
      {/* Línea del grupo: une sus pestañas con la cápsula, como en un navegador. */}
      {groupColor && (
        <span
          aria-hidden="true"
          className={cn("pointer-events-none absolute -bottom-[3px] left-0 h-[2px] rounded-full", lastInGroup ? "right-1" : "-right-0.5")}
          style={{ background: groupColor }}
        />
      )}
      {dropHint && dropHint.side !== "onto" && (
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-1 w-0.5 rounded-full", dropHint.side === "before" ? "-left-1" : "-right-1")}
          style={{ background: dropHint.color ?? "var(--color-accent)" }}
        />
      )}
      {dropHint?.side === "onto" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-1.5 right-1 z-20 grid size-4 place-items-center rounded-full text-on-accent shadow"
          style={{ background: dropHint.color ?? "var(--color-accent)" }}
        >
          <Plus size={10} strokeWidth={3} />
        </span>
      )}
      {editing ? (
        <input
          ref={inputRef}
          data-no-drag
          defaultValue={tab.customTitle ?? label}
          aria-label="Nombre de la pestaña"
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
          }}
          className="ml-2 h-6 w-40 select-text rounded border border-line-strong bg-raised px-1.5 font-mono text-[12px] text-ink outline-none"
        />
      ) : (
        <button
          type="button"
          aria-current={isActive ? "page" : undefined}
          title={`${label}${cwd ? ` · ${cwd}` : ""}${running ? ` · corriendo: ${running}` : ""}${hint ? `  ${hint}` : ""} · doble clic para renombrar`}
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          onAuxClick={(e) => {
            if (e.button === 1 && canClose) actions.closeTab(tab.id);
          }}
          onKeyDown={(e) => {
            // El menú también con teclado (tecla de menú o Shift+F10).
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              useUiStore.getState().openContextMenu({ x: r.left, y: r.bottom + 4, label: `Pestaña ${label}`, items: menu() });
            }
          }}
          className="flex h-full min-w-0 items-center gap-2 pl-2.5 pr-1 outline-offset-[-2px]"
        >
          {needsAttention ? (
            <Lamp state="attention" />
          ) : (
            // La forma dice qué corre (shell, Claude, Codex); el color, de qué
            // proyecto es: el mismo tono en todas las pestañas del mismo repo.
            <span
              className={cn("flex shrink-0", !project && "text-ink-3", !isActive && "opacity-70")}
              style={project ? { color: projectColor(project.root ?? project.cwd) } : undefined}
            >
              <AgentGlyph agentType={agentType ?? null} />
            </span>
          )}
          <span className="min-w-0 max-w-[180px] truncate text-[12.5px] font-medium">{label}</span>
          {runningHint && <span className="max-w-[110px] shrink-0 truncate font-mono text-[11px] text-ink-3">{runningHint}</span>}
          {folderHint && <span className="min-w-0 max-w-[110px] shrink-[2] truncate font-mono text-[11px] text-ink-3">{folderHint}</span>}
          {tab.zoomedPaneId && (
            <Maximize2 size={11} strokeWidth={2} aria-label="Panel maximizado" className="shrink-0 text-accent" />
          )}
        </button>
      )}

      {canClose ? (
        <button
          type="button"
          data-no-drag
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

      {progress.state !== 0 && (
        <span
          role="progressbar"
          aria-label="Progreso"
          aria-valuenow={progress.state === 3 ? undefined : progress.value}
          className="absolute inset-x-3 bottom-[3px] h-[2px] overflow-hidden rounded-full bg-line"
        >
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-300",
              progress.state === 2 ? "bg-signal" : progress.state === 4 ? "bg-ink-3" : "bg-accent",
              progress.state === 3 && "w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite]",
            )}
            style={progress.state === 3 ? undefined : { width: `${Math.max(2, progress.value)}%` }}
          />
        </span>
      )}
    </li>
  );
};

interface GroupChipProps {
  group: TabGroup;
  count: number;
  firstTabId: string;
  /** Plegado esconde sus pestañas: si alguna te espera, lo dice la cápsula. */
  needsAttention: boolean;
  dropHint: "before" | "into" | null;
  isDragged: boolean;
  isEditing: boolean;
  onPointerDownChip: (e: React.PointerEvent) => void;
  onToggle: () => void;
  onEdit: () => void;
}

/**
 * Cápsula del grupo: clic pliega o despliega, clic derecho (o F2) lo edita,
 * arrastrarla mueve el grupo entero. Plegado muestra cuántas pestañas guarda.
 */
const GroupChip: React.FC<GroupChipProps> = ({
  group,
  count,
  firstTabId,
  needsAttention,
  dropHint,
  isDragged,
  isEditing,
  onPointerDownChip,
  onToggle,
  onEdit,
}) => {
  const color = groupColorVar(group.color);
  const label = groupLabel(group);
  const highlighted = dropHint === "into" || isEditing;
  return (
    <li
      data-slot="chip"
      data-group-id={group.id}
      data-top={firstTabId}
      className={cn("relative flex h-[30px] shrink-0 items-center px-0.5", isDragged && "opacity-50")}
    >
      {dropHint === "before" && <span aria-hidden="true" className="absolute inset-y-1 -left-1 w-0.5 rounded-full bg-accent" />}
      {!group.collapsed && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-[3px] -right-0.5 left-1/2 h-[2px] rounded-full"
          style={{ background: color }}
        />
      )}
      <button
        type="button"
        data-group-chip={group.id}
        aria-expanded={!group.collapsed}
        aria-label={`${label}: ${count} ${count === 1 ? "pestaña" : "pestañas"}`}
        title={`${label} · clic para ${group.collapsed ? "desplegar" : "plegar"} · clic derecho para editar`}
        onPointerDown={onPointerDownChip}
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit();
        }}
        onKeyDown={(e) => {
          if (e.key === "F2" || e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            onEdit();
          }
        }}
        className="flex h-[22px] max-w-[160px] items-center gap-1 rounded-[7px] px-2 text-[11.5px] font-semibold leading-none transition-[box-shadow,filter] duration-150 hover:brightness-110"
        style={{
          background: color,
          color: "var(--tg-ink)",
          boxShadow: highlighted ? `0 0 0 2px var(--color-chrome), 0 0 0 3.5px ${color}` : undefined,
        }}
      >
        {group.name ? (
          <span className="truncate">{group.name}</span>
        ) : (
          <span aria-hidden="true" className="size-2 rounded-full bg-current opacity-60" />
        )}
        {group.collapsed && (
          <span className="rounded-full bg-black/15 px-1 py-px font-mono text-[10px] tabular-nums">{count}</span>
        )}
      </button>
      {group.collapsed && needsAttention && (
        <span className="pointer-events-none absolute -right-0.5 -top-0.5">
          <Lamp state="attention" />
        </span>
      )}
    </li>
  );
};

const EDITOR_WIDTH = 272;

const findChip = (groupId: string) => document.querySelector<HTMLElement>(`[data-group-chip="${CSS.escape(groupId)}"]`);

/** Nombre, color y acciones del grupo, en un globo bajo su cápsula. */
const GroupEditor: React.FC<{ groupId: string; onClose: () => void }> = ({ groupId, onClose }) => {
  const group = useTerminalStore((s) => s.groups.find((g) => g.id === groupId));
  const count = useTerminalStore((s) => s.tabs.filter((t) => t.groupId === groupId).length);
  const updateGroup = useTerminalStore((s) => s.updateGroup);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Borrador local: el store recorta espacios y no dejaría escribir «mi grupo».
  const [draft, setDraft] = useState(group?.name ?? "");

  /** `restoreFocus`: cerrado con teclado, el foco vuelve a la cápsula (con el ratón, se queda donde hiciste clic). */
  const close = useCallback(
    (restoreFocus: boolean) => {
      onClose();
      if (restoreFocus) findChip(groupId)?.focus();
    },
    [groupId, onClose],
  );

  // Bajo la cápsula y dentro de la ventana. La cápsula se mueve al plegar o
  // desplegar el grupo o al sumar pestañas: se recoloca con cada cambio.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = findChip(groupId)?.getBoundingClientRect();
    el.style.left = `${r ? Math.min(Math.max(8, r.left), window.innerWidth - EDITOR_WIDTH - 8) : 8}px`;
    el.style.top = `${r ? r.bottom + 8 : 52}px`;
    el.style.visibility = "visible";
  }, [groupId, group?.collapsed, count]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!group) onClose();
  }, [group, onClose]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onResize = () => close(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [close]);

  if (!group) return null;
  const label = groupLabel(group);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Editar ${label}`}
      className="fixed z-50 animate-pop-in rounded-lg border border-[var(--glass-border)] p-3 glass"
      style={{ left: 0, top: 0, width: EDITOR_WIDTH, visibility: "hidden" }}
    >
      <input
        ref={inputRef}
        value={draft}
        maxLength={40}
        spellCheck={false}
        placeholder="Nombre del grupo"
        aria-label="Nombre del grupo"
        onChange={(e) => {
          setDraft(e.target.value);
          updateGroup(groupId, { name: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            close(true);
          }
        }}
        className="h-8 w-full select-text rounded-md border border-line bg-canvas px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong"
      />
      <div role="radiogroup" aria-label="Color del grupo" className="mt-3 grid grid-cols-9 justify-items-center gap-1">
        {GROUP_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={group.color === c}
            aria-label={GROUP_COLOR_NAMES[c]}
            title={GROUP_COLOR_NAMES[c]}
            onClick={() => updateGroup(groupId, { color: c })}
            className="grid size-6 place-items-center rounded-full transition-transform duration-150 hover:scale-110"
            style={{
              background: groupColorVar(c),
              boxShadow: group.color === c ? `0 0 0 2px var(--color-raised), 0 0 0 3.5px ${groupColorVar(c)}` : undefined,
            }}
          >
            {group.color === c && <Check size={13} strokeWidth={3} aria-hidden="true" style={{ color: "var(--tg-ink)" }} />}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-col border-t border-line pt-1.5">
        <EditorAction
          icon={Plus}
          label="Nueva pestaña en el grupo"
          onClick={() => {
            close(false);
            void actions.newTabInGroup(groupId);
          }}
        />
        <EditorAction
          icon={group.collapsed ? ChevronDown : ChevronRight}
          label={group.collapsed ? "Desplegar" : "Plegar"}
          hint="clic en la cápsula"
          onClick={() => actions.toggleGroup(groupId)}
        />
        <EditorAction
          icon={Ungroup}
          label="Desagrupar"
          onClick={() => {
            close(false);
            useTerminalStore.getState().ungroup(groupId);
          }}
        />
        <EditorAction
          icon={X}
          label="Cerrar grupo"
          hint={count === 1 ? "1 pestaña" : `${count} pestañas`}
          danger
          onClick={() => {
            close(false);
            void actions.closeGroup(groupId);
          }}
        />
      </div>
    </div>
  );
};

const EditorAction: React.FC<{
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean }>;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, hint, danger, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "flex h-8 items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors duration-150 hover:bg-hover focus-visible:bg-hover",
      danger ? "text-signal" : "text-ink",
    )}
  >
    <Icon size={14} strokeWidth={1.75} aria-hidden={true} className={danger ? undefined : "text-ink-3"} />
    <span className="flex-1">{label}</span>
    {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
  </button>
);

/**
 * Elegir con qué shell abrir la pestaña nueva (las que hay instaladas). La
 * marcada es la de las pestañas nuevas (Ajustes → Terminal).
 */
const ShellMenu: React.FC = () => {
  const shells = useTerminalStore((s) => s.shells);
  const preferred = useSettingsStore((s) => s.settings.defaultShell);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!shells || shells.length < 2) return null;
  const isPreferred = (path: string, isDefault: boolean) => (preferred ? preferred === path : isDefault);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Pestaña nueva con otra shell"
        title="Pestaña nueva con otra shell"
        onClick={() => setOpen(!open)}
        className={cn(
          "grid h-7 w-4 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent",
          open && "bg-press text-ink",
        )}
      >
        <ChevronDown size={11} strokeWidth={2.25} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Shells instaladas"
          className="absolute left-0 top-9 z-40 w-72 animate-pop-in overflow-hidden rounded-lg border border-[var(--glass-border)] p-1 glass"
        >
          <p className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Pestaña nueva con</p>
          {shells.map((shell) => (
            <button
              key={shell.path}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void actions.newTabWith(shell);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[12.5px] text-ink">
                  {shell.name}
                  {shell.default && <span className="rounded-full bg-hover px-1.5 text-[10px] leading-4 text-ink-3">del sistema</span>}
                </span>
                <span className="block truncate font-mono text-[10.5px] text-ink-3">{tildify(shell.path, terminalManager.getHome())}</span>
              </span>
              {isPreferred(shell.path, shell.default) && (
                <Check size={13} strokeWidth={2} aria-label="La de las pestañas nuevas" className="shrink-0 text-accent" />
              )}
            </button>
          ))}
          <p className="border-t border-line px-2 py-1.5 text-[11px] text-ink-3">La marcada se usa al pulsar +. Cámbiala en Ajustes → Terminal.</p>
        </div>
      )}
    </div>
  );
};
