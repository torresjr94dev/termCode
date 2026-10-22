import { describe, expect, it, vi } from "vitest";
import { welcomeLine } from "./banner";

vi.mock("../TerminalManager", () => ({ terminalManager: { getHome: () => null } }));
vi.mock("../../components/WelcomeCard", () => ({ mountWelcomeCard: vi.fn() }));
const { pickWelcome, CARD_HEIGHT, FULL_MIN_WIDTH } = await import("../../lib/welcome");

describe("welcome", () => {
  it("shows the full card only when it takes at most ~45 % of the pane", () => {
    expect(pickWelcome("full", false, { cols: 120, height: 700, width: 960 })).toBe("full");
    expect(pickWelcome("full", false, { cols: 120, height: CARD_HEIGHT.full / 0.45 - 1, width: 960 })).toBe("compact");
    expect(pickWelcome("full", false, { cols: 120, height: 120, width: 960 })).toBeNull(); // ni la compacta cabe
    expect(pickWelcome("full", false, { cols: 30, height: 700, width: 240 })).toBeNull(); // demasiado angosto
  });

  it("uses the compact card when the full one would wrap past its height", () => {
    expect(pickWelcome("full", false, { cols: 66, height: 700, width: FULL_MIN_WIDTH - 1 })).toBe("compact");
    expect(pickWelcome("full", false, { cols: 80, height: 700, width: FULL_MIN_WIDTH })).toBe("full");
  });

  it("respects the setting and screen readers", () => {
    expect(pickWelcome("off", false, { cols: 120, height: 700, width: 960 })).toBeNull();
    expect(pickWelcome("compact", false, { cols: 120, height: 700, width: 960 })).toBe("compact");
    expect(pickWelcome("full", true, { cols: 120, height: 700, width: 960 })).toBe("line");
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
