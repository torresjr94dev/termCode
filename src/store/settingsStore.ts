import { create } from "zustand";

export type ThemeId = "fosforo" | "fosforo-verde" | "papel";
export type EditorId = "auto" | "cursor" | "code" | "zed" | "subl" | "system";

export interface Settings {
  theme: ThemeId;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  dimInactivePanes: boolean;
  /** Marcas de prompt/comando/salida (zsh). */
  shellIntegration: boolean;
  confirmClose: boolean;
  notifyLongCommands: boolean;
  longCommandSeconds: number;
  /** Dónde se abre un ⌘-clic en una ruta: tu editor o el visor de termCode. */
  openPathsIn: "editor" | "viewer";
  editor: EditorId;
  quickTerminal: boolean;
  quickShortcut: string;
  quickHideOnBlur: boolean;
  /** Avisar antes de lanzar un agente con la sesión de 5 h casi agotada. */
  quotaGuard: boolean;
  screenReader: boolean;
  onboardingDone: boolean;
}

export const DEFAULT_FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';

export const DEFAULT_SETTINGS: Settings = {
  theme: "fosforo",
  fontFamily: DEFAULT_FONT,
  fontSize: 13,
  lineHeight: 1.15,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10_000,
  dimInactivePanes: true,
  shellIntegration: true,
  confirmClose: true,
  notifyLongCommands: true,
  longCommandSeconds: 10,
  openPathsIn: "editor",
  editor: "auto",
  quickTerminal: true,
  quickShortcut: "Alt+Space",
  quickHideOnBlur: true,
  quotaGuard: true,
  screenReader: false,
  onboardingDone: false,
};

export const LIMITS = {
  fontSize: { min: 9, max: 24 },
  lineHeight: { min: 1, max: 1.6 },
  scrollback: { min: 1_000, max: 100_000 },
  longCommandSeconds: { min: 3, max: 600 },
} as const;

const clamp = (value: number, { min, max }: { min: number; max: number }) => Math.min(Math.max(value, min), max);

/** Acepta cualquier cosa (archivo editado a mano, versión vieja) y devuelve ajustes válidos. */
export function sanitize(input: unknown): Settings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof Settings, unknown>>;
  const pick = <K extends keyof Settings>(key: K, valid: (v: unknown) => boolean): Settings[K] =>
    (valid(raw[key]) ? raw[key] : DEFAULT_SETTINGS[key]) as Settings[K];
  const isBool = (v: unknown) => typeof v === "boolean";
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const oneOf = (...options: string[]) => (v: unknown) => typeof v === "string" && options.includes(v);

  return {
    theme: pick("theme", oneOf("fosforo", "fosforo-verde", "papel")),
    fontFamily: pick("fontFamily", (v) => typeof v === "string" && v.trim().length > 0 && v.length < 300),
    fontSize: clamp(pick("fontSize", isNum), LIMITS.fontSize),
    lineHeight: clamp(pick("lineHeight", isNum), LIMITS.lineHeight),
    cursorStyle: pick("cursorStyle", oneOf("block", "bar", "underline")),
    cursorBlink: pick("cursorBlink", isBool),
    scrollback: Math.round(clamp(pick("scrollback", isNum), LIMITS.scrollback)),
    dimInactivePanes: pick("dimInactivePanes", isBool),
    shellIntegration: pick("shellIntegration", isBool),
    confirmClose: pick("confirmClose", isBool),
    notifyLongCommands: pick("notifyLongCommands", isBool),
    longCommandSeconds: Math.round(clamp(pick("longCommandSeconds", isNum), LIMITS.longCommandSeconds)),
    openPathsIn: pick("openPathsIn", oneOf("editor", "viewer")),
    editor: pick("editor", oneOf("auto", "cursor", "code", "zed", "subl", "system")),
    quickTerminal: pick("quickTerminal", isBool),
    quickShortcut: pick("quickShortcut", (v) => typeof v === "string" && /^[\w+]{3,40}$/.test(v)),
    quickHideOnBlur: pick("quickHideOnBlur", isBool),
    quotaGuard: pick("quotaGuard", isBool),
    screenReader: pick("screenReader", isBool),
    onboardingDone: pick("onboardingDone", isBool),
  };
}

interface SettingsState {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  replace: (settings: Settings) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  update: (patch) => set({ settings: sanitize({ ...get().settings, ...patch }) }),
  replace: (settings) => set({ settings: sanitize(settings) }),
}));

export const settingsNow = () => useSettingsStore.getState().settings;
