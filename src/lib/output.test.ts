import { describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalManager", () => ({ terminalManager: { getTracker: vi.fn(), info: vi.fn() } }));
vi.mock("./actions", () => ({ actions: {} }));
const { explainPrompt, tailOf } = await import("./output");

describe("tailOf", () => {
  it("keeps short output whole", () => {
    expect(tailOf("a\nb")).toBe("a\nb");
  });

  it("keeps the end, where the error is, and says how much was left out", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    expect(tailOf(text, 3)).toBe("[… 7 líneas antes]\nl7\nl8\nl9");
  });

  it("also caps very long lines", () => {
    const tail = tailOf("x".repeat(50), 150, 10);
    expect(tail.endsWith("x".repeat(10))).toBe(true);
    expect(tail.length).toBeLessThan(50);
  });
});

describe("explainPrompt", () => {
  it("says what ran, where, how it ended and quotes the output", () => {
    const prompt = explainPrompt("pnpm test", "/repo", 1, "FAIL src/a.test.ts");
    expect(prompt).toContain("Corrí `pnpm test` en `/repo` y terminó con código 1.");
    expect(prompt).toContain("```\nFAIL src/a.test.ts\n```");
  });

  it("works without folder, code or output", () => {
    const prompt = explainPrompt("make", null, null, "");
    expect(prompt).toContain("Corrí `make` y no terminó bien.");
    expect(prompt).toContain("(sin salida)");
  });
});
