import { afterEach, describe, expect, it, vi } from "vitest";

type KeyInit = Partial<Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">>;
const key = (init: KeyInit) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

/** `IS_MAC` se calcula al importar: cada plataforma se prueba con un import limpio. */
async function load(userAgent: string) {
  vi.resetModules();
  vi.stubGlobal("navigator", { userAgent });
  return import("./shortcuts");
}

afterEach(() => vi.unstubAllGlobals());

describe("macOS", () => {
  it("uses ⌘ and leaves Ctrl to the shell", async () => {
    const { matchShortcut } = await load("Macintosh");
    expect(matchShortcut(key({ key: "d", metaKey: true }))).toBe("splitRight");
    expect(matchShortcut(key({ key: "D", metaKey: true, shiftKey: true }))).toBe("splitDown");
    // ^D (EOF), ^W, ^U, ^K pertenecen a la shell.
    for (const k of ["d", "w", "u", "k"]) expect(matchShortcut(key({ key: k, ctrlKey: true }))).toBeNull();
  });

  it("matches + with or without Shift (US vs. Spanish layout)", async () => {
    const { matchShortcut } = await load("Macintosh");
    expect(matchShortcut(key({ key: "+", metaKey: true }))).toBe("fontBigger");
    expect(matchShortcut(key({ key: "+", metaKey: true, shiftKey: true }))).toBe("fontBigger");
    expect(matchShortcut(key({ key: "=", metaKey: true }))).toBe("fontBigger");
  });

  it("navigates panes with ⌥⌘ arrows and tabs with ⌘1-9", async () => {
    const { matchShortcut, matchTabIndex } = await load("Macintosh");
    expect(matchShortcut(key({ key: "ArrowRight", metaKey: true, altKey: true }))).toBe("nextPane");
    expect(matchTabIndex(key({ key: "3", code: "Digit3", metaKey: true }))).toBe(2);
    expect(matchTabIndex(key({ key: "0", code: "Digit0", metaKey: true }))).toBeNull();
  });

  it("labels chords with mac glyphs", async () => {
    const { shortcutLabel, tabShortcutLabel } = await load("Macintosh");
    expect(shortcutLabel("splitDown")).toBe("⇧⌘D");
    expect(shortcutLabel("nextPane")).toBe("⌥⌘→");
    expect(tabShortcutLabel(0)).toBe("⌘1");
    expect(tabShortcutLabel(9)).toBeUndefined();
  });
});

describe("Windows / Linux", () => {
  it("uses Ctrl+Shift so plain Ctrl stays with the shell", async () => {
    const { matchShortcut, shortcutLabel } = await load("Windows NT 10.0");
    expect(matchShortcut(key({ key: "D", ctrlKey: true, shiftKey: true }))).toBe("splitRight");
    expect(matchShortcut(key({ key: "d", ctrlKey: true }))).toBeNull();
    expect(matchShortcut(key({ key: "D", ctrlKey: true, shiftKey: true, altKey: true }))).toBe("splitDown");
    expect(shortcutLabel("splitDown")).toBe("Ctrl+Shift+Alt+D");
  });

  it("matches punctuation and digits by physical key, whatever Shift prints", async () => {
    const { matchShortcut } = await load("Windows NT 10.0");
    const ctrlShift = (k: string, code: string) => key({ key: k, code, ctrlKey: true, shiftKey: true });
    // US: Shift+, = <, Shift+0 = ). Español: Shift+, = ;, Shift+0 = =.
    expect(matchShortcut(ctrlShift("<", "Comma"))).toBe("settings");
    expect(matchShortcut(ctrlShift(";", "Comma"))).toBe("settings");
    expect(matchShortcut(ctrlShift(")", "Digit0"))).toBe("fontReset");
    expect(matchShortcut(ctrlShift("=", "Digit0"))).toBe("fontReset");
    // US: Shift+= = +. Español: la tecla + (donde US tiene ]) da *, y la - (donde US tiene /) da _.
    expect(matchShortcut(ctrlShift("+", "Equal"))).toBe("fontBigger");
    expect(matchShortcut(ctrlShift("*", "BracketRight"))).toBe("fontBigger");
    expect(matchShortcut(ctrlShift("_", "Minus"))).toBe("fontSmaller");
    expect(matchShortcut(ctrlShift("_", "Slash"))).toBe("fontSmaller");
  });
});
