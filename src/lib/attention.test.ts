import { describe, expect, it } from "vitest";
import { agentSummary, nextAttentionPane } from "./attention";
import type { PaneNode, Tab } from "../types/layout";

const pane = (id: string, agentType: PaneNode["agentType"] = null): PaneNode => ({ id, type: "pane", terminalId: `t-${id}`, title: id, agentType });
const tab = (id: string, ...panes: PaneNode[]): Tab => ({
  id,
  title: id,
  activePaneId: panes[0].id,
  root:
    panes.length === 1
      ? panes[0]
      : { id: `s-${id}`, type: "split", direction: "horizontal", ratio: 0.5, first: panes[0], second: panes[1] },
});

const tabs = [tab("t1", pane("shell"), pane("claude-a", "claude")), tab("t2", pane("claude-b", "claude")), tab("t3", pane("codex", "codex"))];

describe("nextAttentionPane", () => {
  it("goes first to whoever is blocked waiting for you, oldest first", () => {
    const attention = {
      shell: { kind: "done", message: "", at: 1 },
      "claude-b": { kind: "needs-input", message: "", at: 50 },
    };
    const activity = { codex: { paneId: "codex", state: "needs-input", detail: "", at: 30 } };
    expect(nextAttentionPane(tabs, attention, activity, undefined)).toEqual({ tabId: "t3", paneId: "codex" });
  });

  it("pending approvals count as blocked", () => {
    const approvals = [{ paneId: "claude-a", at: 99 }];
    const attention = { shell: { kind: "done", message: "", at: 1 } };
    expect(nextAttentionPane(tabs, attention, {}, undefined, approvals)).toEqual({ tabId: "t1", paneId: "claude-a" });
  });

  it("skips the pane you are already on and returns null when nobody needs you", () => {
    const attention = { "claude-b": { kind: "needs-input", message: "", at: 1 } };
    expect(nextAttentionPane(tabs, attention, {}, "claude-b")).toBeNull();
    expect(nextAttentionPane(tabs, {}, {}, undefined)).toBeNull();
  });
});

describe("agentSummary", () => {
  it("counts working and waiting agents and sums the cost", () => {
    const activity = {
      "claude-a": { paneId: "claude-a", state: "working", detail: "", at: 1 },
      "claude-b": { paneId: "claude-b", state: "working", detail: "", at: 1 },
      shell: { paneId: "shell", state: "working", detail: "", at: 1 }, // no es agente
    };
    const status = {
      "claude-a": { paneId: "claude-a", model: null, contextPercent: null, costUsd: 0.5 },
      "claude-b": { paneId: "claude-b", model: null, contextPercent: null, costUsd: 1.25 },
    };
    const summary = agentSummary(tabs, activity, {}, status, [{ paneId: "claude-b" }]);
    expect(summary).toEqual({ agents: 3, working: 1, waiting: 1, costUsd: 1.75 });
  });

  it("reports no cost when no session reports one", () => {
    expect(agentSummary(tabs, {}, {}, {}).costUsd).toBeNull();
  });
});
