import { describe, expect, it } from "vitest";
import { isGenericTitle, paneDisplayName, projectTone, shortCommand } from "./identity";
import type { PaneNode } from "../types/layout";

const pane = (title: string, agentType: PaneNode["agentType"] = null): PaneNode => ({
  id: "p",
  type: "pane",
  terminalId: "t",
  title,
  agentType,
});

describe("identidad", () => {
  it("reconoce títulos que no dicen nada", () => {
    expect(isGenericTitle("zsh")).toBe(true);
    expect(isGenericTitle("-zsh")).toBe(true);
    expect(isGenericTitle("jorge@mac:~/x")).toBe(true);
    expect(isGenericTitle("jorgetorres", "/Users/jorgetorres/dev")).toBe(true);
    expect(isGenericTitle("vim src/App.tsx")).toBe(false);
    expect(isGenericTitle("htop", "/Users/jorgetorres")).toBe(false);
  });

  it("usa el proyecto solo cuando el título es genérico y no es un agente", () => {
    const project = { cwd: "/Users/jorge/termCode/src", name: "termCode", root: "/Users/jorge/termCode" };
    expect(paneDisplayName(pane("zsh"), project)).toBe("termCode");
    expect(paneDisplayName(pane("pnpm dev"), project)).toBe("pnpm dev");
    expect(paneDisplayName(pane("Claude Code", "claude"), project)).toBe("Claude Code");
    expect(paneDisplayName(pane("zsh"))).toBe("zsh");
  });

  it("da un tono estable por proyecto", () => {
    expect(projectTone("/Users/jorge/termCode")).toBe(projectTone("/Users/jorge/termCode"));
    const tones = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => projectTone(`/repo/${k}`)));
    expect(tones.size).toBeGreaterThan(2);
  });

  it("acorta comandos largos", () => {
    expect(shortCommand("pnpm run dev --port 3000")).toBe("pnpm run dev …");
    expect(shortCommand("ls")).toBe("ls");
  });
});
