import React, { useEffect } from "react";
import { useUiStore } from "../store/uiStore";
import { useSettingsStore } from "../store/settingsStore";
import { IS_MAC, shortcutLabel, type ShortcutId } from "../lib/shortcuts";
import { Kbd } from "./ui";

/** Lo que muestra la hoja, agrupado. Todo sale de SHORTCUTS: nada se anuncia sin estar cableado. */
const GROUPS: Array<{ title: string; items: Array<[ShortcutId | ShortcutId[], string]> }> = [
  {
    title: "Pestañas y paneles",
    items: [
      ["newTab", "Pestaña nueva"],
      [["splitRight", "splitDown"], "Dividir panel"],
      [["prevPane", "nextPane"], "Cambiar de panel"],
      ["zoomPane", "Maximizar panel"],
      ["closePane", "Cerrar panel"],
      ["reopenClosed", "Reabrir lo cerrado"],
      ["overview", "Todos los paneles"],
    ],
  },
  {
    title: "Proyecto y git",
    items: [
      ["fileFinder", "Buscar archivo"],
      ["projectChanges", "Cambios y commit"],
      ["projectFiles", "Archivos"],
      ["switchBranch", "Cambiar de rama"],
    ],
  },
  {
    title: "Agentes",
    items: [
      ["nextAttention", "Al que te necesita"],
      ["missionControl", "Mission Control"],
      ["toggleUsage", "Cuota de uso"],
      ["toggleBroadcast", "Escribir en todos"],
    ],
  },
  {
    title: "Terminal",
    items: [
      ["palette", "Comandos"],
      ["find", "Buscar en el panel"],
      [["prevCommand", "nextCommand"], "Saltar entre comandos"],
      [["fontBigger", "fontSmaller"], "Tamaño del texto"],
      ["settings", "Ajustes"],
    ],
  },
];

const HOLD_MS = 550;

/**
 * Mantener ⌘ sola medio segundo muestra la hoja; cualquier otra tecla,
 * soltar ⌘ o perder el foco la oculta (y ⌘C, ⌘V… nunca la disparan).
 */
export function useHoldToShowHints() {
  const enabled = useSettingsStore((s) => s.settings.holdHints);
  useEffect(() => {
    if (!IS_MAC || !enabled) return;
    const ui = useUiStore.getState;
    let timer: number | undefined;
    const hide = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (ui().showHints) ui().setShowHints(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Meta" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.repeat) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => ui().setShowHints(true), HOLD_MS);
      } else if (e.key !== "Meta") {
        hide();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Meta") hide();
    };
    window.addEventListener("keydown", onDown, { capture: true });
    window.addEventListener("keyup", onUp, { capture: true });
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, { capture: true });
    return () => {
      hide();
      window.removeEventListener("keydown", onDown, { capture: true });
      window.removeEventListener("keyup", onUp, { capture: true });
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, { capture: true });
    };
  }, [enabled]);
}

export const ShortcutHints: React.FC = () => {
  useHoldToShowHints();
  const show = useUiStore((s) => s.showHints);
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center px-6" role="status" aria-label="Atajos de teclado">
      <div className="grid w-full max-w-[920px] animate-pop-in grid-cols-2 gap-x-8 gap-y-5 rounded-xl border border-[var(--glass-border)] glass px-6 py-5 lg:grid-cols-4">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">{group.title}</h3>
            <ul className="flex flex-col gap-1.5">
              {group.items.map(([ids, label]) => {
                const keys = (Array.isArray(ids) ? ids : [ids]).map(shortcutLabel);
                return (
                  <li key={label} className="flex items-center justify-between gap-3 text-[12px] text-ink-2">
                    <span className="truncate">{label}</span>
                    <span className="flex shrink-0 gap-1">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <p className="col-span-full border-t border-line pt-3 text-[11.5px] text-ink-3">
          <Kbd>⌘1</Kbd>…<Kbd>⌘9</Kbd> van a esa pestaña · ⌘-clic en una ruta o URL la abre · suelta ⌘ para cerrar
        </p>
      </div>
    </div>
  );
};
