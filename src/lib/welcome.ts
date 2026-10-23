import { version } from "../../package.json";
import { useTerminalStore } from "../store/terminalStore";
import { settingsNow } from "../store/settingsStore";
import { terminalManager, type WelcomeContent } from "../terminal/TerminalManager";
import { welcomeLine } from "../terminal/welcome/banner";
import { mountWelcomeCard } from "../components/WelcomeCard";
import { findOwnerTab, findPane } from "./layout";
import { basename } from "./paths";

/** Alto de cada variante de la tarjeta, en píxeles. */
export const CARD_HEIGHT = { full: 156, compact: 64 } as const;

/**
 * Ancho mínimo del panel (px) para la tarjeta completa. Más angosta, la fila
 * de agentes y cuotas ocupa tres líneas y no cabe en su alto fijo: se recorta.
 */
export const FULL_MIN_WIDTH = 560;

/**
 * Qué bienvenida cabe en un panel de este tamaño. La tarjeta no ocupa más
 * de ~45 % del alto (la shell necesita espacio para trabajar); con lector de
 * pantalla, solo una línea de texto (el resto sería ruido leído en voz alta).
 */
export function pickWelcome(
  mode: "full" | "compact" | "off",
  screenReader: boolean,
  size: { cols: number; height: number; width: number },
): "full" | "compact" | "line" | null {
  if (mode === "off") return null;
  if (screenReader) return size.cols >= 32 ? "line" : null;
  if (size.cols < 40) return null;
  const room = size.height * 0.45;
  if (mode === "full" && room >= CARD_HEIGHT.full && size.width >= FULL_MIN_WIDTH) return "full";
  if (room >= CARD_HEIGHT.compact) return "compact";
  return null;
}

/** Datos reales para la bienvenida de un panel. Nada inventado: lo que no se sabe, no sale. */
export function renderWelcome(paneId: string, size: { cols: number; rows: number; height: number; width: number }): WelcomeContent | null {
  const settings = settingsNow();
  const variant = pickWelcome(settings.welcomeBanner, settings.screenReader, size);
  if (!variant) return null;
  if (variant === "line") {
    return { kind: "text", text: welcomeLine(settings.theme === "neon" || settings.theme === "fosforo-verde" ? "green" : "yellow") };
  }
  const { tabs } = useTerminalStore.getState();
  const owner = findOwnerTab(tabs, paneId);
  const pane = owner ? findPane(owner.root, paneId) : undefined;
  const home = terminalManager.getHome();
  return {
    kind: "card",
    height: CARD_HEIGHT[variant],
    mount: (host, view) =>
      mountWelcomeCard(host, {
        cwd: pane?.cwd ?? null,
        home,
        user: home ? basename(home) : null,
        version,
        compact: variant === "compact",
        fullMinWidth: FULL_MIN_WIDTH,
        compactHeight: CARD_HEIGHT.compact,
        view,
      }),
  };
}
