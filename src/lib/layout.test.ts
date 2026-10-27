import { describe, expect, it } from "vitest";
import type { LayoutNode, PaneNode, SplitNode } from "../types/layout";
import { basename, collectPanes, dropZoneAt, findPane, movePane, neighbourPane, paneRects, removePane, replacePane, setSplitRatio, swapPanes, tabLabel } from "./layout";

const pane = (id: string, title = id): PaneNode => ({ id, type: "pane", terminalId: `t-${id}`, title });
const split = (id: string, first: LayoutNode, second: LayoutNode, ratio = 0.5): SplitNode => ({
  id,
  type: "split",
  direction: "horizontal",
  ratio,
  first,
  second,
});

//   s1
//  /  \
// a    s2
//     /  \
//    b    c
const tree = split("s1", pane("a"), split("s2", pane("b"), pane("c")));

describe("layout tree", () => {
  it("lists panes in visual order", () => {
    expect(collectPanes(tree).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("finds panes at any depth", () => {
    expect(findPane(tree, "c")?.id).toBe("c");
    expect(findPane(tree, "zz")).toBeUndefined();
  });

  it("removing a pane promotes its sibling", () => {
    const result = removePane(tree, "b");
    expect(result && collectPanes(result).map((p) => p.id)).toEqual(["a", "c"]);
    expect((result as SplitNode).second).toEqual(pane("c"));
  });

  it("removing the only pane leaves nothing", () => {
    expect(removePane(pane("solo"), "solo")).toBeNull();
  });

  it("keeps object identity when nothing changes", () => {
    expect(removePane(tree, "missing")).toBe(tree);
    expect(replacePane(tree, "missing", () => pane("x"))).toBe(tree);
    expect(setSplitRatio(tree, "missing", 0.3)).toBe(tree);
  });

  it("clamps split ratios", () => {
    const updated = setSplitRatio(tree, "s2", 0.99) as SplitNode;
    expect((updated.second as SplitNode).ratio).toBe(0.85);
    expect(((setSplitRatio(tree, "s1", 0.01) as SplitNode).ratio)).toBe(0.15);
  });

  it("labels a tab with its active pane title", () => {
    expect(tabLabel({ id: "t", title: "Terminal", root: tree, activePaneId: "b" })).toBe("b");
    expect(tabLabel({ id: "t", title: "Terminal", root: pane("x", ""), activePaneId: "x" })).toBe("Terminal");
  });

  it("extracts basenames", () => {
    expect(basename("/Users/jorge/termCode/")).toBe("termCode");
    expect(basename("/")).toBe("/");
  });
});

/** Forma del árbol en una línea: `(a | (b / c))`; `|` lado a lado, `/` uno sobre otro. */
const shape = (node: LayoutNode): string =>
  node.type === "pane" ? node.id : `(${shape(node.first)} ${node.direction === "horizontal" ? "|" : "/"} ${shape(node.second)})`;

describe("moving panes", () => {
  // a | (b / c): a a la izquierda; b arriba y c abajo a la derecha.
  const three = split("s1", pane("a"), { ...split("s2", pane("b"), pane("c"), 0.3), direction: "vertical" }, 0.6);

  it("swaps two panes and keeps every split and its ratio", () => {
    const swapped = swapPanes(three, "a", "c");
    expect(shape(swapped)).toBe("(c | (b / a))");
    expect(swapped.type === "split" && swapped.ratio).toBe(0.6);
    expect(swapPanes(three, "a", "zz")).toBe(three);
    expect(movePane(three, "a", "c", "center", "n")).toEqual(swapped);
  });

  it("docks a pane on a side of another, closing the gap it left", () => {
    expect(shape(movePane(three, "c", "a", "top", "n"))).toBe("((c / a) | b)");
    expect(shape(movePane(three, "c", "a", "left", "n"))).toBe("((c | a) | b)");
    expect(shape(movePane(three, "a", "b", "bottom", "n"))).toBe("((b / a) / c)");
    expect(shape(movePane(three, "b", "c", "right", "n"))).toBe("(a | (c | b))");
    const moved = movePane(three, "c", "a", "top", "split-new");
    expect(moved.type === "split" && moved.first.type === "split" && moved.first).toMatchObject({ id: "split-new", ratio: 0.5 });
  });

  it("does nothing when there is nothing to move", () => {
    expect(movePane(three, "a", "a", "left", "n")).toBe(three);
    expect(movePane(three, "a", "zz", "left", "n")).toBe(three);
    expect(movePane(pane("solo"), "solo", "solo", "center", "n")).toEqual(pane("solo"));
  });

  it("knows where each pane is and who touches it on each side", () => {
    const rects = Object.fromEntries(paneRects(three).map((r) => [r.id, r.rect]));
    expect(rects.a).toEqual({ x: 0, y: 0, w: 0.6, h: 1 });
    expect(rects.b.x).toBeCloseTo(0.6);
    expect(rects.b.h).toBeCloseTo(0.3);
    expect(rects.c.y).toBeCloseTo(0.3);
    expect(neighbourPane(three, "c", "top")).toBe("b");
    expect(neighbourPane(three, "b", "bottom")).toBe("c");
    expect(neighbourPane(three, "c", "left")).toBe("a");
    // A la derecha de a están b (0–0,3) y c (0,3–1): gana el más alineado con su centro (0,5).
    expect(neighbourPane(three, "a", "right")).toBe("c");
    expect(neighbourPane(three, "a", "left")).toBeNull();
    expect(neighbourPane(three, "b", "top")).toBeNull();
  });

  it("splits a pane into edge zones and a swap zone in the middle", () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    expect(dropZoneAt(box, 110, 150)).toBe("left");
    expect(dropZoneAt(box, 490, 150)).toBe("right");
    expect(dropZoneAt(box, 300, 55)).toBe("top");
    expect(dropZoneAt(box, 300, 245)).toBe("bottom");
    expect(dropZoneAt(box, 300, 150)).toBe("center");
  });
});

