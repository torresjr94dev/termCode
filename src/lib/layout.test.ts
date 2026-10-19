import { describe, expect, it } from "vitest";
import type { LayoutNode, PaneNode, SplitNode } from "../types/layout";
import { basename, collectPanes, findPane, removePane, replacePane, setSplitRatio, tabLabel } from "./layout";

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
