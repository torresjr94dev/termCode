import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "../lib/layout";

/**
 * Glifos de Windows (Segoe Fluent Icons en Windows 11, Segoe MDL2 Assets en
 * Windows 10: mismos códigos). Así los botones son los del sistema, no unos
 * parecidos, y siguen la escala de texto de Windows.
 */
const GLYPH = { minimize: "", maximize: "", restore: "", close: "" } as const;

interface CaptionButtonProps {
  label: string;
  glyph: string;
  onClick: () => void;
  close?: boolean;
}

const CaptionButton: React.FC<CaptionButtonProps> = ({ label, glyph, onClick, close }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className={cn(
      "grid h-full w-[46px] place-items-center text-ink-2 transition-colors duration-100",
      // Rojo de cerrar de Windows 11: igual en tema claro y oscuro.
      close ? "hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/85" : "hover:bg-hover hover:text-ink active:bg-press",
    )}
  >
    <span aria-hidden="true" className="font-['Segoe_Fluent_Icons','Segoe_MDL2_Assets'] text-[10px] leading-none">
      {glyph}
    </span>
  </button>
);

/**
 * Minimizar, maximizar y cerrar en Windows. La ventana no lleva el marco del
 * sistema: la barra de pestañas es la barra de título, como en Windows
 * Terminal. Cerrar pasa por `CloseRequested`, así que el aviso de cambios sin
 * guardar sigue funcionando.
 */
export const WindowControls: React.FC = () => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void win.onResized(sync).then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const win = () => getCurrentWindow();
  return (
    <div className="flex h-full shrink-0 items-stretch">
      <CaptionButton label="Minimizar" glyph={GLYPH.minimize} onClick={() => void win().minimize()} />
      <CaptionButton
        label={maximized ? "Restaurar" : "Maximizar"}
        glyph={maximized ? GLYPH.restore : GLYPH.maximize}
        onClick={() => void win().toggleMaximize()}
      />
      <CaptionButton label="Cerrar" glyph={GLYPH.close} close onClick={() => void win().close()} />
    </div>
  );
};
