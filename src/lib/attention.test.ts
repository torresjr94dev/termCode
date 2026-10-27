import { describe, expect, it } from "vitest";
import { agentStateOf, agentSummary, attentionCandidates, nextAttentionPane, paneAgent } from "./attention";
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

describe("attentionCandidates", () => {
  it("lists everything waiting, urgent first, without the pane you are on", () => {
    const attention = {
      shell: { kind: "done", message: "", at: 1 },
      "claude-b": { kind: "needs-input", message: "", at: 50 },
    };
    const approvals = [{ paneId: "claude-a", at: 70 }];
    const list = attentionCandidates(tabs, attention, {}, "codex", approvals);
    expect(list.map((c) => [c.paneId, c.rank])).toEqual([["claude-b", 0], ["claude-a", 0], ["shell", 1]]);
    expect(attentionCandidates(tabs, attention, {}, "shell")).toHaveLength(1);
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

describe("agentStateOf", () => {
  const act = (state: string) => ({ paneId: "p", state, detail: "", at: 1 });
  const needs = { kind: "needs-input", message: "", at: 1 };

  it("trusts what the agent reports now over an old needs-input mark", () => {
    // El caso del bug: el agente terminó y siguió, pero la marca "te necesita" seguía mandando.
    expect(agentStateOf(act("idle"), needs)).toBe("idle");
    expect(agentStateOf(act("working"), needs)).toBe("working");
  });

  it("is blocked by a pending approval or a live needs-input, and by the mark only when nothing else is known", () => {
    expect(agentStateOf(act("working"), undefined, true)).toBe("needs-input");
    expect(agentStateOf(act("needs-input"), undefined)).toBe("needs-input");
    expect(agentStateOf(undefined, needs)).toBe("needs-input");
    expect(agentStateOf(undefined, undefined)).toBe("idle");
  });
});

describe("paneAgent", () => {
  const osc = (app: string) => ({ paneId: "shell", state: "working", detail: "", at: 1, source: "osc" as const, app });

  it("recognizes an agent typed by hand in a shell once it reports over OSC 7501", () => {
    expect(paneAgent(pane("shell"), osc("claude-code"))).toBe("claude");
    expect(paneAgent(pane("shell"), osc("codex"))).toBe("codex");
    expect(paneAgent(pane("shell"), osc("terraform"))).toBeNull();
    expect(paneAgent(pane("shell"), osc("constructor"))).toBeNull();
    expect(paneAgent(pane("shell"), { ...osc("claude-code"), source: "hook" })).toBeNull();
    expect(paneAgent(pane("x", "codex"))).toBe("codex");
  });

  it("counts those agents in the summary", () => {
    const summary = agentSummary([tab("t", pane("shell"))], { shell: osc("claude-code") }, {}, {});
    expect(summary).toMatchObject({ agents: 1, working: 1 });
  });
});

describe("stale attention", () => {
  it("does not keep an agent that moved on at the top of ⌘J", () => {
    const attention = { "claude-a": { kind: "needs-input", message: "", at: 1 } };
    const activity = { "claude-a": { paneId: "claude-a", state: "idle", detail: "", at: 5 } };
    expect(attentionCandidates(tabs, attention, activity, undefined).map((c) => [c.paneId, c.rank])).toEqual([["claude-a", 1]]);
  });
});
