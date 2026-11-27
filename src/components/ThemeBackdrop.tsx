import React, { useEffect } from "react";
import { useSettingsStore } from "../store/settingsStore";
import { loadBackdrop, useBackdropStore } from "../lib/backdrop";

/**
 * Lo que hay detrás del vidrio en «Vidrio líquido»: tu imagen o el degradado
 * de fábrica. También fija la opacidad (nunca por debajo del mínimo legible
 * para esa imagen) y el desenfoque del vidrio. En los demás temas no pinta
 * nada ni carga nada.
 */
export const ThemeBackdrop: React.FC = () => {
  const active = useSettingsStore((s) => s.settings.theme === "vidrio");
  const image = useSettingsStore((s) => s.settings.glassImage);
  const tint = useSettingsStore((s) => s.settings.glassTint);
  const blur = useSettingsStore((s) => s.settings.glassBlur);
  const url = useBackdropStore((s) => s.url);
  const floor = useBackdropStore((s) => s.floor);

  // La imagen solo se lee del disco con el tema puesto; al quitarlo se suelta.
  useEffect(() => {
    void loadBackdrop(active ? image : null);
  }, [active, image]);

  useEffect(() => {
    const root = document.documentElement.style;
    if (!active) {
      root.removeProperty("--lg-tint");
      root.removeProperty("--lg-blur");
      return;
    }
    root.setProperty("--lg-tint", String(Math.max(tint, floor)));
    root.setProperty("--lg-blur", `${blur}px`);
  }, [active, tint, blur, floor]);

  if (!active) return null;
  return (
    <div
      aria-hidden="true"
      className="lg-backdrop pointer-events-none fixed inset-0 -z-10"
      data-default={url ? undefined : ""}
      style={url ? { backgroundImage: `url("${url}")` } : undefined}
    />
  );
};
