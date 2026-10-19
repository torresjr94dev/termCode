import { beforeEach, describe, expect, it, vi } from "vitest";

// El store solo necesita estas piezas del gestor de terminales (xterm no corre en Node).
vi.mock("../terminal/TerminalManager", () => ({
  FONT_SIZE: { min: 9, max: 24, default: 13 },
  terminalManager: { kill: vi.fn(), focus: vi.fn() },
}));

const { useTerminalStore } = await import("./terminalStore");
const { terminalManager } = await import("../terminal/TerminalManager");
const { collectPanes } = await import("../lib/layout");

const s = () => useTerminalStore.getState();
const paneIds = (tabIndex: number) => collectPanes(s().tabs[tabIndex].root).map((p) => p.id);

beforeEach(() => {
  vi.clearAllMocks();
  // Estado limpio: una sola pestaña con un solo panel.
  const fresh = {
    id: "tab-test",
    title: "Terminal",
    root: { id: "pane-test", type: "pane" as const, terminalId: "term-test", title: "zsh" },
    activePaneId: "pane-test",
  };
  useTerminalStore.setState({ tabs: [fresh], activeTabId: fresh.id, attention: {}, agentStatus: {}, closed: [] });
});

describe("closePane", () => {
  it("closes a pane in a background tab without touching the active one", () => {
    s().createTab(); // tab 1 queda activa
    const background = s().tabs[0];
    s().splitPane(background.activePaneId, "horizontal");
    const [left, right] = paneIds(0);
    const activeBefore = s().tabs[1];

    s().closePane(right);

    expect(paneIds(0)).toEqual([left]);
    expect(s().tabs[0].activePaneId).toBe(left);
    expect(s().tabs[1]).toBe(activeBefore);
    expect(s().activeTabId).toBe(activeBefore.id);
    expect(terminalManager.kill).toHaveBeenCalledWith(right);
  });

  it("closing the last pane closes its tab", () => {
    s().createTab();
    const doomed = s().tabs[1];
    s().closePane(doomed.activePaneId);
    expect(s().tabs.map((t) => t.id)).not.toContain(doomed.id);
    expect(s().tabs).toHaveLength(1);
  });

  it("closing the only pane of the only tab leaves a fresh tab", () => {
    const only = s().tabs[0];
    s().closePane(only.activePaneId);
    expect(s().tabs).toHaveLength(1);
    expect(s().tabs[0].id).not.toBe(only.id);
  });

  it("forgets agent status and attention of closed panes", () => {
    s().splitPane(s().tabs[0].activePaneId, "vertical");
    const [, agent] = paneIds(0);
    s().setAgentStatus({ paneId: agent, model: "Opus", contextPercent: 10, costUsd: 0 });
    s().setAttention(agent, { kind: "done", message: "", at: 1 });
    s().closePane(agent);
    expect(s().agentStatus).toEqual({});
    expect(s().attention).toEqual({});
  });
});

describe("titles, attention and font", () => {
  it("updates titles of panes in any tab", () => {
    const backgroundPane = s().tabs[0].activePaneId;
    s().createTab();
    s().updatePaneTitle(backgroundPane, "~/termCode");
    expect(collectPanes(s().tabs[0].root)[0].title).toBe("~/termCode");
  });

  it("ignores attention for panes that do not exist", () => {
    s().setAttention("ghost", { kind: "bell", message: "", at: 1 });
    expect(s().attention).toEqual({});
  });

  it("renames, reorders and remembers closed tabs", () => {
    s().createTab();
    s().createTab();
    const ids = s().tabs.map((t) => t.id);
    s().renameTab(ids[0], "  backend  ");
    expect(s().tabs[0].customTitle).toBe("backend");
    s().renameTab(ids[0], "");
    expect(s().tabs[0].customTitle).toBeUndefined();

    s().moveTab(0, 2);
    expect(s().tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
    s().moveTab(0, 9); // fuera de rango: no hace nada
    expect(s().tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);

    s().rememberClosed({ title: "a", cwds: ["/a"] });
    s().rememberClosed({ title: "b", cwds: ["/b"] });
    expect(s().popClosed()?.title).toBe("b");
    expect(s().popClosed()?.title).toBe("a");
    expect(s().popClosed()).toBeUndefined();
  });

  it("zooms a pane and drops the zoom when the split goes away", () => {
    const first = s().tabs[0].activePaneId;
    s().toggleZoom(); // un solo panel: no hay nada que maximizar
    expect(s().tabs[0].zoomedPaneId).toBeUndefined();

    s().splitPane(first, "horizontal");
    const second = s().tabs[0].activePaneId;
    s().toggleZoom(first);
    expect(s().tabs[0].zoomedPaneId).toBe(first);
    expect(s().tabs[0].activePaneId).toBe(first);
    s().closePane(second);
    expect(s().tabs[0].zoomedPaneId).toBeNull();
  });

  it("equalizes split ratios", () => {
    s().splitPane(s().tabs[0].activePaneId, "horizontal");
    const root = s().tabs[0].root;
    if (root.type !== "split") throw new Error("esperaba un split");
    s().updateSplitRatio(root.id, 0.8);
    s().equalizeSplits();
    const after = s().tabs[0].root;
    expect(after.type === "split" && after.ratio).toBe(0.5);
  });

  it("splits inherit the spec (cwd, agent)", () => {
    s().splitPane(s().tabs[0].activePaneId, "horizontal", { cwd: "/repo", agentType: "claude", command: "claude" });
    const created = collectPanes(s().tabs[0].root)[1];
    expect(created).toMatchObject({ cwd: "/repo", agentType: "claude", command: "claude" });
    expect(s().tabs[0].activePaneId).toBe(created.id);
  });
});
