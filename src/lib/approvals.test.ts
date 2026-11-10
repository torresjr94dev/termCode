import { describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalManager", () => ({ terminalManager: { kill: vi.fn(), focus: vi.fn() } }));
const { approvalHeadline, approvalSummary, approvalView, toolLabel } = await import("./approvals");

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

  it("says what the agent wants without echoing the tool name", () => {
    const head = (tool: string, input: unknown, cwd: string | null = "/repo") => approvalHeadline(tool, approvalView(tool, input), cwd);
    expect(head("Bash", { command: "ls" })).toEqual({ verb: "Quiere ejecutar un comando", target: null });
    expect(head("Edit", { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" })).toEqual({ verb: "Quiere editar", target: "src/a.ts" });
    expect(head("Write", { file_path: "/repo/b.md", content: "" })).toEqual({ verb: "Quiere escribir", target: "b.md" });
    // Fuera de la carpeta del agente, la ruta completa: no se disfraza de archivo del repo.
    expect(head("Edit", { file_path: "/Users/x/.zshrc", old_string: "a", new_string: "b" }).target).toBe("/Users/x/.zshrc");
    expect(head("Edit", { file_path: "/repo2/a.ts", old_string: "a", new_string: "b" }).target).toBe("/repo2/a.ts");
    expect(head("Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }, null).target).toBe("/repo/a.ts");
    expect(head("Edit", { file_path: "C:\\repo\\src\\a.ts", old_string: "a", new_string: "b" }, "C:\\repo").target).toBe("src\\a.ts");
    expect(head("mcp__github__create_issue", { title: "x" })).toEqual({ verb: "Quiere usar", target: "github · create_issue" });
  });

  it("summarizes in one line for notifications", () => {
    expect(approvalSummary({ tool: "Bash", input: { command: "npm test\n--watch" } })).toBe("Bash: npm test");
    expect(approvalSummary({ tool: "Write", input: { file_path: "/repo/src/db/schema.ts", content: "" } })).toBe("Write: schema.ts");
  });
});
