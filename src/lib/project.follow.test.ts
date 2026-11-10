import { beforeEach, describe, expect, it, vi } from "vitest";

// El panel de proyecto sigue al panel activo de la terminal. En Windows el backend no sabe la
// carpeta de ningún proceso (pty_info sin cwd): solo la shell con integración la dice (OSC 7).
vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return { ...actual, IS_TAURI: true, ipc: { ...actual.ipc, cloudProvider: vi.fn(async () => null) } };
});

const known: Record<string, string | null> = {};
vi.mock("../terminal/TerminalManager", () => ({
  terminalManager: {
    knownCwd: vi.fn((id: string) => known[id] ?? null),
    info: vi.fn(async () => ({ shellPid: 1, foregroundPid: null, foregroundName: null, cwd: null, busy: true })),
    focus: vi.fn(),
  },
}));

vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return {
    ...actual,
    gitApi: {
      repo: vi.fn(async (cwd: string) => ({ root: cwd, name: cwd.split("\\").pop(), remoteUrl: null, webUrl: null, host: "other", defaultBranch: "main" })),
      status: vi.fn(async () => ({ branch: "main", head: "1", upstream: null, ahead: 0, behind: 0, changes: [], operation: null })),
      list: vi.fn(async () => []),
      stashList: vi.fn(async () => []),
      ciStatus: vi.fn(async () => null),
      prStatus: vi.fn(async () => null),
    },
  };
});

const { useTerminalStore } = await import("../store/terminalStore");
const { useProjectStore } = await import("../store/projectStore");
const { syncNow } = await import("./project");

const pane = (id: string, cwd: string, agent: "claude" | null) => ({
  id,
  type: "pane" as const,
  terminalId: `term-${id}`,
  title: agent ? "Claude Code" : "pwsh",
  cwd,
  agentType: agent,
  ...(agent ? { command: "claude" } : {}),
});

describe("el panel de proyecto sigue a la pestaña activa", () => {
  beforeEach(() => {
    known.shell = "C:\\dev\\api";
    known.agent = null;
    useProjectStore.setState({ cwd: null, repo: null });
    useTerminalStore.setState({
      tabs: [
        { id: "tab-shell", title: "pwsh", activePaneId: "shell", root: pane("shell", "C:\\Users\\yo", null) },
        { id: "tab-agent", title: "Claude Code", activePaneId: "agent", root: pane("agent", "C:\\dev\\tienda", "claude") },
      ],
      activeTabId: "tab-shell",
    });
  });

  it("a la carpeta de un agente aunque el backend no la sepa (Windows)", async () => {
    syncNow();
    await vi.waitFor(() => expect(useProjectStore.getState().cwd).toBe("C:\\dev\\api"));
    useTerminalStore.setState({ activeTabId: "tab-agent" });
    syncNow();
    await vi.waitFor(() => expect(useProjectStore.getState().cwd).toBe("C:\\dev\\tienda"));
    expect(useProjectStore.getState().repo?.root).toBe("C:\\dev\\tienda");
  });

  it("la carpeta en vivo (OSC 7) manda sobre la de arranque", async () => {
    // La shell arrancó en C:\Users\yo y luego hizo cd: el panel va adonde está ahora.
    syncNow();
    await vi.waitFor(() => expect(useProjectStore.getState().cwd).toBe("C:\\dev\\api"));
  });
});
