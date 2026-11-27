import { describe, expect, it } from "vitest";
import type { Tab, TabGroup } from "../types/layout";
import {
  cleanGroupName,
  dropTab,
  groupTab,
  joinGroup,
  leaveGroup,
  moveGroup,
  nextGroupColor,
  normalizeGroups,
  sanitizeGroups,
  stripItems,
  tabOutsideGroup,
  ungroup,
  type Grouping,
} from "./tabGroups";

const tab = (id: string, groupId?: string): Tab => ({
  id,
  title: id,
  root: { id: `p-${id}`, type: "pane", terminalId: `t-${id}`, title: "zsh" },
  activePaneId: `p-${id}`,
  ...(groupId ? { groupId } : {}),
});
const group = (id: string, over: Partial<TabGroup> = {}): TabGroup => ({ id, name: id.toUpperCase(), color: "azul", collapsed: false, ...over });

/** `a b [g: c d] e` → ids en orden con su grupo, fácil de comparar. */
const shape = (s: Grouping) => s.tabs.map((t) => (t.groupId ? `${t.id}@${t.groupId}` : t.id)).join(" ");
const make = (id: string) => () => group(id);

describe("normalizeGroups", () => {
  it("devuelve las mismas referencias si ya está bien", () => {
    const tabs = [tab("a"), tab("b", "g"), tab("c", "g"), tab("d")];
    const groups = [group("g")];
    const out = normalizeGroups(tabs, groups);
    expect(out.tabs).toBe(tabs);
    expect(out.groups).toBe(groups);
  });

  it("junta las pestañas de un grupo donde aparece la primera", () => {
    const out = normalizeGroups([tab("a", "g"), tab("b"), tab("c", "g"), tab("d")], [group("g")]);
    expect(shape(out)).toBe("a@g c@g b d");
  });

  it("suelta pestañas de grupos que no existen y borra grupos vacíos", () => {
    const out = normalizeGroups([tab("a", "fantasma"), tab("b")], [group("g")]);
    expect(shape(out)).toBe("a b");
    expect(out.groups).toEqual([]);
  });
});

describe("dropTab", () => {
  const base: Grouping = { tabs: [tab("a"), tab("b", "g"), tab("c", "g"), tab("d")], groups: [group("g")] };

  it("soltar encima de una pestaña suelta crea un grupo con las dos", () => {
    const out = dropTab(base, "d", { kind: "onto", targetId: "a" }, make("nuevo"));
    expect(shape(out)).toBe("a@nuevo d@nuevo b@g c@g");
    expect(out.created).toBe("nuevo");
    expect(out.groups.map((g) => g.id)).toEqual(["g", "nuevo"]);
  });

  it("soltar encima de una pestaña agrupada entra a su grupo, sin crear otro", () => {
    const out = dropTab(base, "a", { kind: "onto", targetId: "b" }, make("nuevo"));
    expect(shape(out)).toBe("b@g a@g c@g d");
    expect(out.created).toBeNull();
  });

  it("junto a una pestaña de un grupo, entra al grupo", () => {
    expect(shape(dropTab(base, "d", { kind: "after", targetId: "c" }, make("x")))).toBe("a b@g c@g d@g");
    // Antes de la primera del grupo = entre la cápsula y ella: dentro.
    expect(shape(dropTab(base, "a", { kind: "before", targetId: "b" }, make("x")))).toBe("a@g b@g c@g d");
  });

  it("junto a una pestaña suelta, sale de su grupo (y el grupo que queda vacío desaparece)", () => {
    const out = dropTab(base, "c", { kind: "before", targetId: "d" }, make("x"));
    expect(shape(out)).toBe("a b@g c d");
    const empty = dropTab(out, "b", { kind: "after", targetId: "d" }, make("x"));
    expect(shape(empty)).toBe("a c d b");
    expect(empty.groups).toEqual([]);
  });

  it("antes de la cápsula queda fuera; sobre ella, dentro", () => {
    expect(shape(dropTab(base, "d", { kind: "chip-before", groupId: "g" }, make("x")))).toBe("a d b@g c@g");
    expect(shape(dropTab(base, "d", { kind: "chip-into", groupId: "g" }, make("x")))).toBe("a d@g b@g c@g");
  });

  it("sobre la cápsula de un grupo plegado, va al final del grupo", () => {
    const collapsed = { ...base, groups: [group("g", { collapsed: true })] };
    expect(shape(dropTab(collapsed, "a", { kind: "chip-into", groupId: "g" }, make("x")))).toBe("b@g c@g a@g d");
  });

  it("al final, sin grupo", () => {
    expect(shape(dropTab(base, "b", { kind: "end" }, make("x")))).toBe("a c@g d b");
  });

  it("sobre sí misma o con ids que no existen no cambia nada", () => {
    expect(dropTab(base, "a", { kind: "onto", targetId: "a" }, make("x")).tabs).toBe(base.tabs);
    expect(dropTab(base, "zzz", { kind: "end" }, make("x")).tabs).toBe(base.tabs);
    expect(dropTab(base, "a", { kind: "before", targetId: "zzz" }, make("x")).tabs).toBe(base.tabs);
  });

  it("reordenar dentro del mismo grupo conserva el objeto de la pestaña", () => {
    const out = dropTab(base, "c", { kind: "before", targetId: "b" }, make("x"));
    expect(shape(out)).toBe("a c@g b@g d");
    expect(out.tabs[1]).toBe(base.tabs[2]);
  });
});

describe("moveGroup", () => {
  const base: Grouping = {
    tabs: [tab("a"), tab("b", "g"), tab("c", "g"), tab("d"), tab("e", "h"), tab("f", "h")],
    groups: [group("g"), group("h")],
  };

  it("mueve el bloque entero", () => {
    expect(shape(moveGroup(base, "g", null))).toBe("a d e@h f@h b@g c@g");
    expect(shape(moveGroup(base, "h", "a"))).toBe("e@h f@h a b@g c@g d");
  });

  it("nunca dentro de otro grupo: se pone antes de ese grupo", () => {
    expect(shape(moveGroup(base, "h", "c"))).toBe("a e@h f@h b@g c@g d");
  });

  it("sin cambios devuelve el mismo estado", () => {
    expect(moveGroup(base, "g", "d")).toBe(base);
    expect(moveGroup(base, "g", "b")).toBe(base);
    expect(moveGroup(base, "nada", null)).toBe(base);
  });
});

describe("menú de la pestaña", () => {
  const base: Grouping = { tabs: [tab("a"), tab("b", "g"), tab("c", "g"), tab("d", "g"), tab("e")], groups: [group("g")] };

  it("grupo nuevo con una pestaña suelta: se queda en su sitio", () => {
    const out = groupTab(base, "e", group("n"));
    expect(shape(out)).toBe("a b@g c@g d@g e@n");
  });

  it("grupo nuevo con una pestaña de otro grupo: sale por el borde derecho del suyo", () => {
    expect(shape(groupTab(base, "c", group("n")))).toBe("a b@g d@g c@n e");
  });

  it("unirse a un grupo la pone al final del grupo", () => {
    expect(shape(joinGroup(base, "a", "g"))).toBe("b@g c@g d@g a@g e");
    expect(joinGroup(base, "b", "g")).toBe(base);
  });

  it("salir del grupo la deja justo a su derecha", () => {
    expect(shape(leaveGroup(base, "b"))).toBe("a c@g d@g b e");
    expect(leaveGroup(base, "a")).toBe(base);
  });

  it("desagrupar deja las pestañas donde estaban", () => {
    const out = ungroup(base, "g");
    expect(shape(out)).toBe("a b c d e");
    expect(out.groups).toEqual([]);
  });
});

describe("tabOutsideGroup", () => {
  it("prefiere la de la derecha, luego la de la izquierda", () => {
    expect(tabOutsideGroup([tab("a"), tab("b", "g"), tab("c")], "g")?.id).toBe("c");
    expect(tabOutsideGroup([tab("a"), tab("b", "g")], "g")?.id).toBe("a");
    expect(tabOutsideGroup([tab("b", "g")], "g")).toBeNull();
  });
});

describe("stripItems", () => {
  it("agrupa las pestañas bajo su cápsula y conserva el índice real", () => {
    const items = stripItems([tab("a"), tab("b", "g"), tab("c", "g"), tab("d")], [group("g")]);
    expect(items.map((i) => (i.kind === "tab" ? i.tab.id : `[${i.tabs.map((t) => `${t.tab.id}:${t.index}`).join(",")}]`))).toEqual([
      "a",
      "[b:1,c:2]",
      "d",
    ]);
  });
});

describe("saneado", () => {
  it("nombre sin controles, recortado", () => {
    expect(cleanGroupName("  api\u0007 \n")).toBe("api");
    expect(cleanGroupName("x".repeat(100))).toHaveLength(40);
  });

  it("solo pasan grupos válidos y sin ids repetidos", () => {
    const out = sanitizeGroups([
      { id: "g", name: "Front\u0000", color: "verde", collapsed: true },
      { id: "g", name: "dup", color: "rojo" },
      { id: "", name: "sin id" },
      { id: "h", name: 42, color: "fucsia", collapsed: "sí" },
      null,
      "texto",
    ]);
    expect(out).toEqual([
      { id: "g", name: "Front", color: "verde", collapsed: true },
      { id: "h", name: "", color: "gris", collapsed: false },
    ]);
    expect(sanitizeGroups("nada")).toEqual([]);
  });

  it("el color siguiente es uno sin usar", () => {
    expect(nextGroupColor([])).toBe("azul");
    expect(nextGroupColor([group("a", { color: "azul" }), group("b", { color: "rojo" })])).toBe("amarillo");
  });
});
