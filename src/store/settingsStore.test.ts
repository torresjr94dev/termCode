import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitize, useSettingsStore } from "./settingsStore";

describe("settings", () => {
  it("fills missing or invalid values with defaults", () => {
    const s = sanitize({ theme: "neón", fontSize: "grande", cursorBlink: "sí", editor: "vim" });
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(s.cursorBlink).toBe(DEFAULT_SETTINGS.cursorBlink);
    expect(s.editor).toBe("auto");
    expect(sanitize(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps numbers to safe ranges", () => {
    const s = sanitize({ fontSize: 400, lineHeight: 0.2, scrollback: 10, longCommandSeconds: 99999 });
    expect([s.fontSize, s.lineHeight, s.scrollback, s.longCommandSeconds]).toEqual([24, 1, 1000, 600]);
  });

  it("rejects suspicious shortcuts and fonts", () => {
    expect(sanitize({ quickShortcut: "Alt+Space; rm -rf" }).quickShortcut).toBe(DEFAULT_SETTINGS.quickShortcut);
    expect(sanitize({ fontFamily: "" }).fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
  });

  it("updates through the store with validation", () => {
    useSettingsStore.getState().update({ fontSize: 15, theme: "papel" });
    expect(useSettingsStore.getState().settings).toMatchObject({ fontSize: 15, theme: "papel" });
    useSettingsStore.getState().update({ fontSize: -3 });
    expect(useSettingsStore.getState().settings.fontSize).toBe(9);
  });
});
