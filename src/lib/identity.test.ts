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

  it("reconoce el título que pone ConPTY en Windows", () => {
    expect(isGenericTitle("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(true);
    expect(isGenericTitle("Administrador: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(true);
    expect(isGenericTitle("Administrator: C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
    expect(isGenericTitle("pwsh.exe")).toBe(true);
    expect(isGenericTitle("C:\\Windows\\system32\\cmd.exe")).toBe(true);
    expect(isGenericTitle("Windows PowerShell")).toBe(true);
    expect(isGenericTitle("Soporte", "C:\\Users\\Soporte\\repo")).toBe(true);
    expect(isGenericTitle("C:\\tools\\htop.exe")).toBe(false);
    expect(isGenericTitle("npm: C:\\repo")).toBe(false);
  });

  it("usa el proyecto solo cuando el título es genérico y no es un agente", () => {
    const project = { cwd: "/Users/jorge/termCode/src", name: "termCode", root: "/Users/jorge/termCode" };
    expect(paneDisplayName(pane("zsh"), project)).toBe("termCode");
    expect(paneDisplayName(pane("pnpm dev"), project)).toBe("pnpm dev");
    expect(paneDisplayName(pane("Claude Code", "claude"), project)).toBe("Claude Code");
    expect(paneDisplayName(pane("zsh"))).toBe("zsh");
    expect(paneDisplayName(pane("Administrador: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))).toBe("powershell");
    const windows = { cwd: "C:\\Users\\Soporte\\termCode", name: "termCode", root: "C:\\Users\\Soporte\\termCode" };
    expect(paneDisplayName(pane("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), windows)).toBe("termCode");
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

describe("cleanTitle", () => {
  it("drops agent spinner glyphs but keeps real titles", async () => {
    const { cleanTitle } = await import("./identity");
    expect(cleanTitle("✳ Claude Code")).toBe("Claude Code");
    expect(cleanTitle("⠂ Claude Code")).toBe("Claude Code");
    expect(cleanTitle("~/repo")).toBe("~/repo");
    expect(cleanTitle("vim notas.md")).toBe("vim notas.md");
    expect(cleanTitle("✳")).toBe("✳"); // solo símbolo: mejor eso que nada
  });
});
