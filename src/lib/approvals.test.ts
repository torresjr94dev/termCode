import { describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalManager", () => ({ terminalManager: { kill: vi.fn(), focus: vi.fn() } }));
const { approvalSummary, approvalView, toolLabel } = await import("./approvals");

describe("approvalView", () => {
  it("shows commands whole, never cut", () => {
    const command = `pnpm add zod && ${"x".repeat(500)}\nrm -rf dist`;
    expect(approvalView("Bash", { command, description: "Instala zod" })).toEqual({ kind: "command", command, description: "Instala zod" });
  });

  it("turns edits into before/after pairs", () => {
    expect(approvalView("Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b", replace_all: true })).toEqual({
      kind: "edit",
      path: "/r/a.ts",
      edits: [{ before: "a", after: "b" }],
      replaceAll: true,
    });
    expect(approvalView("MultiEdit", { file_path: "/r/a.ts", edits: [{ old_string: "1", new_string: "2" }] })).toMatchObject({
      kind: "edit",
      edits: [{ before: "1", after: "2" }],
    });
  });

  it("falls back to the full JSON when the shape is unexpected", () => {
    expect(approvalView("Bash", { cmd: "ls" })).toEqual({ kind: "raw", json: JSON.stringify({ cmd: "ls" }, null, 2) });
    expect(approvalView("MultiEdit", { file_path: "/a", edits: [{ old_string: 1 }] }).kind).toBe("raw");
    expect(approvalView("mcp__github__create_issue", { title: "x" }).kind).toBe("raw");
  });
});

describe("labels", () => {
  it("names MCP tools by server and tool", () => {
    expect(toolLabel("mcp__github__create_issue")).toBe("github · create_issue");
    expect(toolLabel("Bash")).toBe("Bash");
  });

  it("summarizes in one line for notifications", () => {
    expect(approvalSummary({ tool: "Bash", input: { command: "npm test\n--watch" } })).toBe("Bash: npm test");
    expect(approvalSummary({ tool: "Write", input: { file_path: "/repo/src/db/schema.ts", content: "" } })).toBe("Write: schema.ts");
  });
});
