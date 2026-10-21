import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalManager", () => ({ terminalManager: { kill: vi.fn(), focus: vi.fn(), info: vi.fn() } }));
vi.mock("./bridge", () => ({ notify: vi.fn() }));

const { gitApi } = await import("./git");
const { useRaceStore } = await import("../store/raceStore");
const { onAgentDone, raceScore, verifyEntry } = await import("./race");

const flush = () => new Promise((r) => setTimeout(r, 0));
const entry = (worktree: string, paneId: string) => ({ paneId, agent: "claude" as const, worktree, verify: { status: "pending" as const } });

beforeEach(() => {
  useRaceStore.setState({
    race: { id: "r", prompt: "x", command: "pnpm test", startedAt: 0, entries: [entry("/wt/a", "pa"), entry("/wt/b", "pb")] },
  });
});

describe("race judge", () => {
  it("verifies one worktree at a time, in the order agents finish", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    vi.spyOn(gitApi, "worktreeVerify").mockImplementation(async (worktree) => {
      calls.push(`start ${worktree}`);
      if (worktree === "/wt/b") await new Promise<void>((r) => (release = r));
      calls.push(`end ${worktree}`);
      return { code: worktree === "/wt/a" ? 1 : 0, timedOut: false, output: "", durationMs: 5 };
    });

    onAgentDone("pb");
    onAgentDone("pa");
    await flush();
    expect(useRaceStore.getState().race?.entries.map((e) => e.verify.status)).toEqual(["queued", "running"]);
    release();
    await flush();
    await flush();
    expect(calls).toEqual(["start /wt/b", "end /wt/b", "start /wt/a", "end /wt/a"]);
    expect(raceScore(useRaceStore.getState().race!.entries)).toEqual({ total: 2, judged: 2, passed: 1 });
  });

  it("does nothing without a judge or for panes outside the race", () => {
    const spy = vi.spyOn(gitApi, "worktreeVerify");
    spy.mockClear();
    onAgentDone("ghost");
    useRaceStore.setState({ race: { ...useRaceStore.getState().race!, command: null } });
    verifyEntry("/wt/a");
    expect(spy).not.toHaveBeenCalled();
  });
});
