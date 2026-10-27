import { beforeEach, describe, expect, it, vi } from "vitest";

// El store solo necesita estas piezas del gestor de terminales (xterm no corre en Node).
vi.mock("../terminal/TerminalManager", () => ({
  FONT_SIZE: { min: 9, max: 24, default: 13 },
  terminalManager: { kill: vi.fn(), focus: vi.fn() },
}));

const { liveAgent, useTerminalStore } = await import("./terminalStore");
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
  useTerminalStore.setState({ tabs: [fresh], activeTabId: fresh.id, attention: {}, agentStatus: {}, runningAgent: {}, closed: [] });
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

  it("replaces a pane in place with a new process, keeping it active", () => {
    const old = s().tabs[0].activePaneId;
    s().setAttention(old, { kind: "done", message: "", at: 1 });
    const fresh = s().replacePane(old, { cwd: "/repo", agentType: "claude", command: "claude --resume x" });
    expect(fresh).not.toBe(old);
    expect(collectPanes(s().tabs[0].root)).toEqual([expect.objectContaining({ id: fresh, agentType: "claude", cwd: "/repo" })]);
    expect(s().tabs[0].activePaneId).toBe(fresh);
    expect(terminalManager.kill).toHaveBeenCalledWith(old);
    expect(s().attention).toEqual({});
  });

  it("remembers the agent session, keeping the last prompt when the session restarts", () => {
    const shell = s().tabs[0].activePaneId;
    s().setAgentSession(shell, { id: "session-1234", at: 1 });
    expect(collectPanes(s().tabs[0].root)[0].agentSession).toBeUndefined(); // una shell no tiene sesión

    s().splitPane(shell, "horizontal", { agentType: "claude", command: "claude" });
    const agent = s().tabs[0].activePaneId;
    s().setAgentSession(agent, { id: "session-1234", prompt: "hola", at: 2 });
    s().setAgentSession(agent, { id: "session-1234", at: 3 }); // SessionStart: sin mensaje
    expect(collectPanes(s().tabs[0].root)[1].agentSession).toEqual({ id: "session-1234", prompt: "hola", at: 2 });
    s().setAgentSession(agent, { id: "session-9999", at: 4 }); // /clear: sesión nueva
    expect(collectPanes(s().tabs[0].root)[1].agentSession).toEqual({ id: "session-9999", prompt: undefined, at: 4 });
  });

  it("a `claude` typed in a shell makes the pane an agent until it leaves", () => {
    const shell = s().tabs[0].activePaneId;
    s().setRunningAgent(shell, "claude");
    const pane = collectPanes(s().tabs[0].root)[0];
    expect(liveAgent(s(), pane)).toBe("claude");
    // Una shell acoplada o un panel que ya no existe no se vuelven agentes.
    s().setRunningAgent("drawer-x", "codex");
    expect(s().runningAgent).toEqual({ [shell]: "claude" });
    s().setRunningAgent(shell, null);
    expect(liveAgent(s(), pane)).toBeNull();
    // Al cerrar el panel no queda rastro.
    s().splitPane(shell, "horizontal", {});
    const other = s().tabs[0].activePaneId;
    s().setRunningAgent(other, "codex");
    s().closePane(other);
    expect(s().runningAgent).toEqual({});
  });

  it("moves a pane within its tab without killing any terminal", () => {
    const a = s().tabs[0].activePaneId;
    s().splitPane(a, "horizontal", {});
    const b = s().tabs[0].activePaneId;
    s().splitPane(b, "vertical", {});
    const c = s().tabs[0].activePaneId;
    s().toggleZoom(b);
    s().movePane(c, a, "left");
    const tab = s().tabs[0];
    expect(collectPanes(tab.root).map((p) => p.id)).toEqual([c, a, b]);
    expect(tab.activePaneId).toBe(c);
    expect(tab.zoomedPaneId).toBeNull();
    expect(terminalManager.kill).not.toHaveBeenCalled();
    // Otro panel de otra pestaña no es destino.
    s().createTab();
    const other = s().tabs[1].activePaneId;
    const before = s().tabs[0].root;
    s().movePane(a, other, "center");
    expect(s().tabs[0].root).toBe(before);
  });

  it("splits inherit the spec (cwd, agent)", () => {
    s().splitPane(s().tabs[0].activePaneId, "horizontal", { cwd: "/repo", agentType: "claude", command: "claude" });
    const created = collectPanes(s().tabs[0].root)[1];
    expect(created).toMatchObject({ cwd: "/repo", agentType: "claude", command: "claude" });
    expect(s().tabs[0].activePaneId).toBe(created.id);
  });
});
