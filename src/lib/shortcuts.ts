/**
 * Única fuente de verdad de los atajos. La paleta, los tooltips y el manejador
 * global leen de aquí: ningún atajo se anuncia si no está realmente cableado.
 *
 * macOS: ⌘ es el modificador (Ctrl queda libre para la shell: ^D, ^W, ^U, ^K…).
 * Otros SO: Ctrl+Shift es el modificador; `shift` del acorde se traduce a +Alt.
 */

export type ShortcutId =
  | "palette"
  | "newTab"
  | "closePane"
  | "splitRight"
  | "splitDown"
  | "nextPane"
  | "prevPane"
  | "toggleSidebar"
  | "toggleUsage"
  | "toggleBroadcast";

interface Chord {
  /** `KeyboardEvent.key` en minúsculas (letras) o nombre de tecla (`ArrowRight`). */
  key: string;
  shift?: boolean;
  alt?: boolean;
}

export const SHORTCUTS: Record<ShortcutId, Chord> = {
  palette: { key: "k" },
  newTab: { key: "t" },
  closePane: { key: "w" },
  splitRight: { key: "d" },
  splitDown: { key: "d", shift: true },
  nextPane: { key: "ArrowRight", alt: true },
  prevPane: { key: "ArrowLeft", alt: true },
  toggleSidebar: { key: "b" },
  toggleUsage: { key: "u" },
  toggleBroadcast: { key: "i", shift: true },
};

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const KEY_GLYPHS: Record<string, string> = {
  ArrowRight: "→",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

function hasMod(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}

function chordMatches(e: KeyboardEvent, chord: Chord): boolean {
  const wantShift = IS_MAC ? Boolean(chord.shift) : true;
  const wantAlt = IS_MAC ? Boolean(chord.alt) : Boolean(chord.alt || chord.shift);
  if (e.shiftKey !== wantShift || e.altKey !== wantAlt) return false;
  return chord.key.length === 1 ? e.key.toLowerCase() === chord.key : e.key === chord.key;
}

export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  if (!hasMod(e)) return null;
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    if (chordMatches(e, SHORTCUTS[id])) return id;
  }
  return null;
}

/** ⌘1…⌘9 → índice 0…8. Usa `code` para no depender del layout del teclado. */
export function matchTabIndex(e: KeyboardEvent): number | null {
  if (!hasMod(e) || e.altKey || (IS_MAC && e.shiftKey)) return null;
  const match = /^Digit([1-9])$/.exec(e.code);
  return match ? Number(match[1]) - 1 : null;
}

function formatChord(chord: Chord): string {
  const key = KEY_GLYPHS[chord.key] ?? chord.key.toUpperCase();
  if (IS_MAC) {
    return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}⌘${key}`;
  }
  const parts = ["Ctrl", "Shift"];
  if (chord.alt || chord.shift) parts.push("Alt");
  return [...parts, key].join("+");
}

export function shortcutLabel(id: ShortcutId): string {
  return formatChord(SHORTCUTS[id]);
}

export function tabShortcutLabel(index: number): string | undefined {
  if (index > 8) return undefined;
  return IS_MAC ? `⌘${index + 1}` : `Ctrl+Shift+${index + 1}`;
}
