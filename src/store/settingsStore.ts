import { create } from "zustand";
import { IS_MAC } from "../lib/shortcuts";

export type ThemeId = "neon" | "fosforo" | "fosforo-verde" | "papel" | "navidad" | "vidrio";

export const THEME_IDS: readonly ThemeId[] = ["neon", "fosforo", "fosforo-verde", "papel", "navidad", "vidrio"];

/** Nombres para mostrar, en el orden de los selectores. */
export const THEME_NAMES: Record<ThemeId, string> = {
  neon: "Neón",
  fosforo: "Fósforo",
  "fosforo-verde": "Fósforo verde",
  papel: "Papel",
  navidad: "Navidad",
  vidrio: "Vidrio líquido",
};

/** Llevan la etiqueta «Nuevo» en Ajustes hasta que los pruebas. */
export const NEW_THEMES: readonly ThemeId[] = ["navidad", "vidrio"];

/** Nombre de un fondo guardado por el backend (`fondo-<ms>.<ext>`, ver backdrop.rs). */
export const isBackdropName = (v: unknown): v is string => typeof v === "string" && /^fondo-\d{1,20}\.(png|jpg|gif|webp|avif)$/.test(v);
export type EditorId = "auto" | "cursor" | "code" | "zed" | "subl" | "system";

export interface Settings {
  theme: ThemeId;
  /** Temas que ya probaste (pierden la etiqueta «Nuevo»). */
  themesTried: ThemeId[];
  /** Navidad: nieve de pixeles cayendo (y el trineo que pasa de vez en cuando). */
  festiveSnow: boolean;
  /** Vidrio líquido: tu imagen de fondo (copia guardada por la app); null = el degradado de fábrica. */
  glassImage: string | null;
  /** Vidrio líquido: qué tan opaco es el vidrio de los paneles (0.4–0.92). Con fondos claros sube solo para que el texto se lea. */
  glassTint: number;
  /** Vidrio líquido: desenfoque de lo que hay detrás, en px (0 = sin desenfoque, lo más ligero). */
  glassBlur: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  /** Al reabrir, cada terminal vuelve con lo que tenía (últimas líneas, guardadas en tu equipo). */
  restoreScrollback: boolean;
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
  /** Los agentes pueden leer la salida de otros paneles (MCP de solo lectura). */
  agentsReadPanes: boolean;
  /** Los permisos de Claude se aprueban desde la bandeja, sin ir a su panel. */
  approvalsInApp: boolean;
  /** Barra arriba de cada shell (carpeta, rama, abrir un agente ahí). Los agentes y las divisiones la llevan siempre. */
  paneBar: boolean;
  screenReader: boolean;
  /** Ruta de la shell de las pestañas nuevas; vacío = la del sistema. */
  defaultShell: string;
  /** Mantener ⌘ sola muestra la hoja de atajos (macOS). */
  holdHints: boolean;
  onboardingDone: boolean;
}

export const DEFAULT_FONT = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';

export const DEFAULT_SETTINGS: Settings = {
  theme: "neon",
  themesTried: [],
  festiveSnow: true,
  glassImage: null,
  glassTint: 0.62,
  glassBlur: 24,
  fontFamily: DEFAULT_FONT,
  fontSize: 13,
  lineHeight: 1.15,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10_000,
  restoreScrollback: true,
  dimInactivePanes: true,
  shellIntegration: true,
  confirmClose: true,
  notifyLongCommands: true,
  longCommandSeconds: 10,
  openPathsIn: "editor",
  editor: "auto",
  quickTerminal: true,
  // Alt+Space es el menú de la ventana en Windows y en GNOME: no se le roba al sistema.
  quickShortcut: IS_MAC ? "Alt+Space" : "Ctrl+Alt+Space",
  quickHideOnBlur: true,
  quotaGuard: true,
  agentsReadPanes: true,
  approvalsInApp: true,
  paneBar: true,
  defaultShell: "",
  screenReader: false,
  holdHints: true,
  onboardingDone: false,
};

export const LIMITS = {
  glassTint: { min: 0.4, max: 0.92 },
  glassBlur: { min: 0, max: 48 },
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
    theme: pick("theme", oneOf(...THEME_IDS)),
    themesTried: Array.isArray(raw.themesTried)
      ? THEME_IDS.filter((id) => (raw.themesTried as unknown[]).includes(id))
      : DEFAULT_SETTINGS.themesTried,
    festiveSnow: pick("festiveSnow", isBool),
    glassImage: raw.glassImage === null || isBackdropName(raw.glassImage) ? ((raw.glassImage ?? null) as string | null) : DEFAULT_SETTINGS.glassImage,
    glassTint: Math.round(clamp(pick("glassTint", isNum), LIMITS.glassTint) * 100) / 100,
    glassBlur: Math.round(clamp(pick("glassBlur", isNum), LIMITS.glassBlur)),
    fontFamily: pick("fontFamily", (v) => typeof v === "string" && v.trim().length > 0 && v.length < 300),
    fontSize: clamp(pick("fontSize", isNum), LIMITS.fontSize),
    lineHeight: clamp(pick("lineHeight", isNum), LIMITS.lineHeight),
    cursorStyle: pick("cursorStyle", oneOf("block", "bar", "underline")),
    cursorBlink: pick("cursorBlink", isBool),
    scrollback: Math.round(clamp(pick("scrollback", isNum), LIMITS.scrollback)),
    restoreScrollback: pick("restoreScrollback", isBool),
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
    agentsReadPanes: pick("agentsReadPanes", isBool),
    approvalsInApp: pick("approvalsInApp", isBool),
    // La barra reemplazó a la tarjeta de bienvenida (0.5.0): quien la había apagado, tampoco ve la barra.
    paneBar: isBool(raw.paneBar) ? (raw.paneBar as boolean) : (raw as Record<string, unknown>).welcomeBanner !== "off",
    defaultShell: pick("defaultShell", (v) => typeof v === "string" && v.length < 4096),
    screenReader: pick("screenReader", isBool),
    holdHints: pick("holdHints", isBool),
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
  update: (patch) => {
    const current = get().settings;
    // Elegir un tema (desde Ajustes o la paleta) es probarlo: pierde la etiqueta «Nuevo».
    const tried =
      patch.theme && !current.themesTried.includes(patch.theme) ? { themesTried: [...current.themesTried, patch.theme] } : {};
    set({ settings: sanitize({ ...current, ...patch, ...tried }) });
  },
  replace: (settings) => set({ settings: sanitize(settings) }),
}));

export const settingsNow = () => useSettingsStore.getState().settings;
