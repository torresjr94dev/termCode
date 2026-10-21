import { describe, expect, it, vi } from "vitest";
import { welcomeLine } from "./banner";

vi.mock("../TerminalManager", () => ({ terminalManager: { getHome: () => null } }));
vi.mock("../../components/WelcomeCard", () => ({ mountWelcomeCard: vi.fn() }));
const { pickWelcome, CARD_HEIGHT } = await import("../../lib/welcome");

describe("welcome", () => {
  it("shows the full card only when it takes at most ~45 % of the pane", () => {
    expect(pickWelcome("full", false, { cols: 120, height: 700 })).toBe("full");
    expect(pickWelcome("full", false, { cols: 120, height: CARD_HEIGHT.full / 0.45 - 1 })).toBe("compact");
    expect(pickWelcome("full", false, { cols: 120, height: 120 })).toBeNull(); // ni la compacta cabe
    expect(pickWelcome("full", false, { cols: 30, height: 700 })).toBeNull(); // demasiado angosto
  });

  it("respects the setting and screen readers", () => {
    expect(pickWelcome("off", false, { cols: 120, height: 700 })).toBeNull();
    expect(pickWelcome("compact", false, { cols: 120, height: 700 })).toBe("compact");
    expect(pickWelcome("full", true, { cols: 120, height: 700 })).toBe("line");
  });

  it("writes the screen-reader line with palette colors only", () => {
    const line = welcomeLine("green");
    expect(line).toContain("termCode");
    expect(line).toContain("by CODERGENIUS MX");
    expect(line).toContain("\x1b[0;32m»");
    expect(line).not.toMatch(/\[[0-9;]*38;[25];/); // sin truecolor
    expect(welcomeLine("yellow")).toContain("\x1b[0;33m»");
  });
});
