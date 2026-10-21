import { describe, expect, it, vi } from "vitest";
import { agentCommand, isSafeSessionId } from "./resume";

vi.mock("../terminal/TerminalManager", () => ({ terminalManager: { info: vi.fn() } }));
const { asShells, sanitizeResumable } = await import("./persistence");

const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const ID = "0b6f2a43-1c1e-4e57-9d0e-6b8f1c2d3e4f";

describe("agentCommand", () => {
  it("resumes Claude with its settings and MCP passed again", () => {
    expect(agentCommand("claude", "claude", quote, { settingsPath: "/s/a b.json", mcpConfigPath: "/s/mcp.json", resume: ID })).toBe(
      `claude --settings '/s/a b.json' --mcp-config '/s/mcp.json' --resume '${ID}'`,
    );
  });

  it("resumes Codex by id or the latest one of the folder", () => {
    expect(agentCommand("codex", "codex", quote, { resume: "last" })).toBe("codex resume --last");
    expect(agentCommand("codex", "codex", quote, { resume: ID })).toBe(`codex resume '${ID}'`);
  });

  it("never lets an unsafe session id reach the shell", () => {
    const evil = "x'; rm -rf ~; echo '";
    expect(isSafeSessionId(evil)).toBe(false);
    expect(agentCommand("claude", "claude", quote, { resume: evil })).toBe("claude");
  });

  it("passes the first prompt after --", () => {
    expect(agentCommand("claude", "claude", quote, { prompt: "  it's done  " })).toBe(`claude -- 'it'\\''s done'`);
  });
});

describe("restoring a session", () => {
  const agentPane = {
    id: "pane-a",
    type: "pane" as const,
    terminalId: "term-a",
    title: "Claude Code",
    cwd: "/repo/app",
    command: "claude --settings x",
    agentType: "claude" as const,
    agentSession: { id: ID, prompt: "Agrega paginación", at: 10 },
  };

  it("turns an agent into a shell that remembers how to resume it", () => {
    const restored = asShells(agentPane);
    expect(restored).toMatchObject({ title: "app", command: undefined, agentType: null });
    expect(restored.type === "pane" && restored.resumable).toEqual({
      agent: "claude",
      sessionId: ID,
      title: "Claude Code",
      prompt: "Agrega paginación",
      at: 10,
    });
    expect(restored.type === "pane" && restored.agentSession).toBeUndefined();
  });

  it("keeps an unused resume offer across another restart", () => {
    const once = asShells(agentPane);
    expect(asShells(once)).toEqual(once);
  });

  it("drops tampered resume data", () => {
    expect(sanitizeResumable({ agent: "rm", title: "x" })).toBeUndefined();
    expect(sanitizeResumable({ agent: "claude", title: "x", sessionId: "$(reboot)" })?.sessionId).toBeNull();
  });

  it("leaves plain shells alone", () => {
    const shell = { id: "p", type: "pane" as const, terminalId: "t", title: "zsh", cwd: "/x" };
    expect(asShells(shell)).toEqual(shell);
  });
});
