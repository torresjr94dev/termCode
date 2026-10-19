import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalManager", () => ({
  FONT_SIZE: { min: 9, max: 24, default: 13 },
  terminalManager: { kill: vi.fn(), focus: vi.fn(), setFontSize: vi.fn(), info: vi.fn(), paste: vi.fn() },
}));

vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return {
    ...actual,
    gitApi: {
      lastCommit: vi.fn(),
      commit: vi.fn(async () => ({ sha: "abc1234", summary: "ok" })),
      status: vi.fn(),
    },
  };
});

const { gitApi } = await import("./git");
const { useProjectStore } = await import("../store/projectStore");
const { useUiStore } = await import("../store/uiStore");
const { commit, refreshStatus, setAmend } = await import("./project");

const project = () => useProjectStore.getState();
const repo = { root: "/repo", name: "repo", remoteUrl: null, webUrl: null, host: "other" as const, defaultBranch: "main" };
const status = (head: string) => ({ branch: "main", head, upstream: null, ahead: 0, behind: 0, changes: [], operation: null });
const last = (publishedIn: string[] = []) => ({
  sha: "1111111111111111111111111111111111111111",
  short: "1111111",
  message: "Arregla el parsre\n\n- detalle",
  publishedIn,
});

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ confirm: null, toast: null });
  useProjectStore.setState({
    repo,
    status: status("111111111111"),
    draft: "lo que estaba escribiendo",
    amend: false,
    amendBase: null,
    draftBeforeAmend: "",
    busy: null,
  });
});

describe("amend", () => {
  it("loads the last commit message and gives the draft back when turned off", async () => {
    vi.mocked(gitApi.lastCommit).mockResolvedValue(last());
    await setAmend(true);
    expect(project().amend).toBe(true);
    expect(project().draft).toBe("Arregla el parsre\n\n- detalle");

    await setAmend(false);
    expect(project().amend).toBe(false);
    expect(project().draft).toBe("lo que estaba escribiendo");
  });

  it("commits an unpublished amend directly", async () => {
    vi.mocked(gitApi.lastCommit).mockResolvedValue(last());
    await setAmend(true);
    project().set({ draft: "Arregla el parser" });
    await commit();
    expect(gitApi.commit).toHaveBeenCalledWith("/repo", "Arregla el parser", true);
    expect(project().amend).toBe(false);
    expect(project().draft).toBe("");
  });

  it("asks before rewriting a published commit", async () => {
    vi.mocked(gitApi.lastCommit).mockResolvedValue(last(["origin/main"]));
    await setAmend(true);
    await commit();
    expect(gitApi.commit).not.toHaveBeenCalled();
    expect(useUiStore.getState().confirm?.body).toContain("origin/main");

    useUiStore.getState().resolveConfirm(true);
    await vi.waitFor(() => expect(gitApi.commit).toHaveBeenCalledWith("/repo", expect.any(String), true));
  });

  it("turns itself off when HEAD moves under it", async () => {
    vi.mocked(gitApi.lastCommit).mockResolvedValue(last());
    await setAmend(true);
    vi.mocked(gitApi.status).mockResolvedValue(status("222222222222"));
    await refreshStatus();
    expect(project().amend).toBe(false);
    expect(project().draft).toBe("lo que estaba escribiendo");
  });

  it("reports when there is nothing to amend", async () => {
    vi.mocked(gitApi.lastCommit).mockRejectedValue(new Error("Todavía no hay commits que enmendar."));
    await setAmend(true);
    expect(project().amend).toBe(false);
    expect(useUiStore.getState().toast?.text).toBe("Todavía no hay commits que enmendar.");
  });
});
