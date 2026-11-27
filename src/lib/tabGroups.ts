/**
 * Grupos de pestañas: funciones puras sobre `(tabs, groups)`.
 *
 * Invariantes que todas devuelven cumplidas (`normalizeGroups`):
 * - las pestañas de un grupo están juntas en `tabs`;
 * - ninguna pestaña apunta a un grupo que no existe;
 * - no hay grupos vacíos.
 * Si nada cambia, devuelven las mismas referencias (sin re-render ni autoguardado).
 */
import type { GroupColor, Tab, TabGroup } from "../types/layout";

export interface Grouping {
  tabs: Tab[];
  groups: TabGroup[];
}

export const GROUP_COLORS: readonly GroupColor[] = ["gris", "azul", "rojo", "amarillo", "verde", "rosa", "morado", "cian", "naranja"];

export const GROUP_COLOR_NAMES: Record<GroupColor, string> = {
  gris: "Gris",
  azul: "Azul",
  rojo: "Rojo",
  amarillo: "Amarillo",
  verde: "Verde",
  rosa: "Rosa",
  morado: "Morado",
  cian: "Cian",
  naranja: "Naranja",
};

export const MAX_GROUP_NAME = 40;
const MAX_GROUPS = 100;

export const isGroupColor = (value: unknown): value is GroupColor =>
  typeof value === "string" && (GROUP_COLORS as readonly string[]).includes(value);

/** Color del grupo como variable CSS (cada tema define su tono legible). */
export const groupColorVar = (color: GroupColor) => `var(--tg-${color})`;

/** Sin caracteres de control ni espacios de sobra, y con tope de largo. */
export function cleanGroupName(name: string): string {
  return [...name]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, MAX_GROUP_NAME);
}

/** El primer color que nadie usa (el gris queda para cuando ya no hay otro). */
export function nextGroupColor(groups: TabGroup[]): GroupColor {
  const used = new Set(groups.map((g) => g.color));
  const vivid = GROUP_COLORS.filter((c) => c !== "gris");
  return vivid.find((c) => !used.has(c)) ?? vivid[groups.length % vivid.length];
}

function withoutGroup(tab: Tab): Tab {
  if (tab.groupId === undefined) return tab;
  const { groupId: _groupId, ...rest } = tab;
  return rest;
}

function withGroup(tab: Tab, groupId: string | undefined): Tab {
  if (tab.groupId === groupId) return tab;
  return groupId ? { ...tab, groupId } : withoutGroup(tab);
}

const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => item === b[i]);

/** Repara cualquier `(tabs, groups)` para que cumpla las invariantes. */
export function normalizeGroups(tabs: Tab[], groups: TabGroup[]): Grouping {
  const known = new Set(groups.map((g) => g.id));
  const cleaned = tabs.map((t) => (t.groupId && !known.has(t.groupId) ? withoutGroup(t) : t));

  const members = new Map<string, Tab[]>();
  for (const tab of cleaned) {
    if (!tab.groupId) continue;
    const list = members.get(tab.groupId);
    if (list) list.push(tab);
    else members.set(tab.groupId, [tab]);
  }

  // Cada grupo queda donde aparece su primera pestaña; las demás se le juntan.
  const ordered: Tab[] = [];
  const placed = new Set<string>();
  for (const tab of cleaned) {
    if (!tab.groupId) ordered.push(tab);
    else if (!placed.has(tab.groupId)) {
      placed.add(tab.groupId);
      ordered.push(...(members.get(tab.groupId) ?? []));
    }
  }

  const live = groups.filter((g) => members.has(g.id));
  return {
    tabs: sameList(ordered, tabs) ? tabs : ordered,
    groups: live.length === groups.length ? groups : live,
  };
}

/** Lo que llega del disco: solo grupos con forma de grupo, sin ids repetidos. */
export function sanitizeGroups(value: unknown): TabGroup[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: TabGroup[] = [];
  for (const raw of value.slice(0, MAX_GROUPS)) {
    if (!raw || typeof raw !== "object") continue;
    const { id, name, color, collapsed } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 80 || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof name === "string" ? cleanGroupName(name) : "",
      color: isGroupColor(color) ? color : "gris",
      collapsed: collapsed === true,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Arrastrar y soltar                                                  */
/* ------------------------------------------------------------------ */

/**
 * Dónde cae una pestaña arrastrada:
 * - `before`/`after`: junto a otra pestaña, y entra al grupo de esa (o sale del suyo si esa no tiene);
 * - `onto`: encima de otra: se agrupan (en el grupo de la de abajo o en uno nuevo);
 * - `chip-before`: antes de la cápsula de un grupo, fuera de él;
 * - `chip-into`: sobre la cápsula: entra al grupo;
 * - `end`: al final de todo, sin grupo.
 */
export type TabDrop =
  | { kind: "before" | "after" | "onto"; targetId: string }
  | { kind: "chip-before" | "chip-into"; groupId: string }
  | { kind: "end" };

export interface DropResult extends Grouping {
  /** Grupo que nació con este arrastre (para abrir su editor). */
  created: string | null;
}

export function dropTab(state: Grouping, draggedId: string, drop: TabDrop, makeGroup: (groups: TabGroup[]) => TabGroup): DropResult {
  const unchanged: DropResult = { ...state, created: null };
  const dragged = state.tabs.find((t) => t.id === draggedId);
  if (!dragged) return unchanged;
  if ("targetId" in drop && drop.targetId === draggedId) return unchanged;

  const rest = state.tabs.filter((t) => t.id !== draggedId);
  let groups = state.groups;
  let created: string | null = null;
  let at: number;
  let groupId: string | undefined;

  switch (drop.kind) {
    case "before":
    case "after": {
      const i = rest.findIndex((t) => t.id === drop.targetId);
      if (i === -1) return unchanged;
      at = drop.kind === "before" ? i : i + 1;
      groupId = rest[i].groupId;
      break;
    }
    case "onto": {
      const i = rest.findIndex((t) => t.id === drop.targetId);
      if (i === -1) return unchanged;
      const target = rest[i];
      if (target.groupId) {
        groupId = target.groupId;
      } else {
        const group = makeGroup(groups);
        groups = [...groups, group];
        created = group.id;
        groupId = group.id;
        rest[i] = withGroup(target, group.id);
      }
      at = i + 1;
      break;
    }
    case "chip-before": {
      const i = rest.findIndex((t) => t.groupId === drop.groupId);
      if (i === -1) return unchanged;
      at = i;
      groupId = undefined;
      break;
    }
    case "chip-into": {
      const first = rest.findIndex((t) => t.groupId === drop.groupId);
      if (first === -1) return unchanged;
      const last = rest.findLastIndex((t) => t.groupId === drop.groupId);
      // Plegado no se ve dónde cae: al final. Desplegado, junto a la cápsula.
      at = state.groups.find((g) => g.id === drop.groupId)?.collapsed ? last + 1 : first;
      groupId = drop.groupId;
      break;
    }
    case "end":
      at = rest.length;
      groupId = undefined;
      break;
  }

  rest.splice(at, 0, withGroup(dragged, groupId));
  return { ...normalizeGroups(rest, groups), created };
}

/** Mueve el grupo entero antes de esa pestaña (`null` = al final). Nunca lo mete dentro de otro grupo. */
export function moveGroup(state: Grouping, groupId: string, beforeTabId: string | null): Grouping {
  const block = state.tabs.filter((t) => t.groupId === groupId);
  if (!block.length || block.some((t) => t.id === beforeTabId)) return state;
  const rest = state.tabs.filter((t) => t.groupId !== groupId);
  let at = beforeTabId === null ? rest.length : rest.findIndex((t) => t.id === beforeTabId);
  if (at === -1) return state;
  const host = rest[at]?.groupId;
  if (host) at = rest.findIndex((t) => t.groupId === host);
  rest.splice(at, 0, ...block);
  return sameList(rest, state.tabs) ? state : { tabs: rest, groups: state.groups };
}

/* ------------------------------------------------------------------ */
/* Menú de la pestaña                                                  */
/* ------------------------------------------------------------------ */

/** Un grupo nuevo solo con esa pestaña (queda donde está). */
export function groupTab(state: Grouping, tabId: string, group: TabGroup): Grouping {
  const i = state.tabs.findIndex((t) => t.id === tabId);
  if (i === -1) return state;
  const tabs = [...state.tabs];
  const source = tabs[i].groupId;
  tabs[i] = withGroup(tabs[i], group.id);
  // Si venía de un grupo, sale por su borde derecho (no queda partido en dos).
  if (source) {
    const [moved] = tabs.splice(i, 1);
    const last = tabs.findLastIndex((t) => t.groupId === source);
    tabs.splice(last === -1 ? i : Math.max(i, last + 1), 0, moved);
  }
  return normalizeGroups(tabs, [...state.groups, group]);
}

/** La pestaña pasa al final de ese grupo. */
export function joinGroup(state: Grouping, tabId: string, groupId: string): Grouping {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.groupId === groupId) return state;
  const last = state.tabs.findLast((t) => t.groupId === groupId && t.id !== tabId);
  if (!last) return state;
  return dropTab(state, tabId, { kind: "after", targetId: last.id }, () => {
    throw new Error("joinGroup no crea grupos");
  });
}

/** Sale del grupo y queda justo a su derecha (como en un navegador). */
export function leaveGroup(state: Grouping, tabId: string): Grouping {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab?.groupId) return state;
  const source = tab.groupId;
  const rest = state.tabs.filter((t) => t.id !== tabId);
  const last = rest.findLastIndex((t) => t.groupId === source);
  const at = last === -1 ? state.tabs.indexOf(tab) : last + 1;
  rest.splice(at, 0, withoutGroup(tab));
  return normalizeGroups(rest, state.groups);
}

/** Deshace el grupo: sus pestañas se quedan donde están. */
export function ungroup(state: Grouping, groupId: string): Grouping {
  if (!state.groups.some((g) => g.id === groupId)) return state;
  return normalizeGroups(
    state.tabs.map((t) => (t.groupId === groupId ? withoutGroup(t) : t)),
    state.groups.filter((g) => g.id !== groupId),
  );
}

/**
 * La pestaña que queda a la vista si se pliega el grupo de la activa: la de
 * su derecha, o si no hay, la de su izquierda. `null`: el grupo es todo.
 */
export function tabOutsideGroup(tabs: Tab[], groupId: string): Tab | null {
  const first = tabs.findIndex((t) => t.groupId === groupId);
  const last = tabs.findLastIndex((t) => t.groupId === groupId);
  if (first === -1) return null;
  return tabs[last + 1] ?? tabs[first - 1] ?? null;
}

/* ------------------------------------------------------------------ */
/* La tira de pestañas                                                 */
/* ------------------------------------------------------------------ */

export interface IndexedTab {
  tab: Tab;
  /** Posición en `tabs` (la del atajo ⌘1…⌘9). */
  index: number;
}

export type StripItem = ({ kind: "tab" } & IndexedTab) | { kind: "group"; group: TabGroup; tabs: IndexedTab[] };

/** Lo que pinta la barra: pestañas sueltas y grupos (cápsula + sus pestañas). */
export function stripItems(tabs: Tab[], groups: TabGroup[]): StripItem[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const items: StripItem[] = [];
  tabs.forEach((tab, index) => {
    const group = tab.groupId ? byId.get(tab.groupId) : undefined;
    if (!group) {
      items.push({ kind: "tab", tab, index });
      return;
    }
    const prev = items.at(-1);
    if (prev?.kind === "group" && prev.group.id === group.id) prev.tabs.push({ tab, index });
    else items.push({ kind: "group", group, tabs: [{ tab, index }] });
  });
  return items;
}
