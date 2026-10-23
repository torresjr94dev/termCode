import { describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalManager", () => ({ terminalManager: { info: vi.fn(), serialize: vi.fn(), setRestore: vi.fn() } }));
const { capBuffers, sanitizeBuffers } = await import("./buffers");
const { sanitizeShell } = await import("./persistence");

describe("sanitizeBuffers", () => {
  it("keeps only valid entries from disk", () => {
    expect(sanitizeBuffers({ version: 1, panes: { a: { text: "hola", at: 1 }, b: { text: 3, at: 1 }, c: { text: "x" } } })).toEqual({
      a: { text: "hola", at: 1 },
    });
    expect(sanitizeBuffers({ version: 2, panes: {} })).toEqual({});
    expect(sanitizeBuffers("basura")).toEqual({});
  });
});

describe("capBuffers", () => {
  it("keeps the most recent panes within the total", () => {
    const panes = { viejo: { text: "x".repeat(6), at: 1 }, nuevo: { text: "y".repeat(6), at: 2 }, chico: { text: "z", at: 0 } };
    expect(Object.keys(capBuffers(panes, 7)).sort()).toEqual(["chico", "nuevo"]);
  });
});

describe("sanitizeShell", () => {
  it("only lets an absolute path with text arguments come back", () => {
    expect(sanitizeShell({ name: "bash", path: "/opt/homebrew/bin/bash", args: ["-l"] })).toEqual({ name: "bash", path: "/opt/homebrew/bin/bash", args: ["-l"] });
    expect(sanitizeShell({ name: "pwsh", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [1] })?.args).toEqual([]);
    expect(sanitizeShell({ name: "x", path: "bash" })).toBeUndefined();
    expect(sanitizeShell(null)).toBeUndefined();
  });
});
