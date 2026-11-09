import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUiStore, type ContextMenuRequest, type MenuItem } from "../store/uiStore";
import { cn } from "../lib/layout";
import { Kbd } from "./ui";

/** Margen con el borde de la ventana. */
const EDGE = 8;

/**
 * Menú contextual propio. El del webview solo traía «Recargar» (que cierra
 * todas las terminales y agentes) y, en un enlace, «Abrir enlace» (que saca a
 * la app de su página): ver `useNativeMenuGuard` en App.
 */
export const ContextMenu: React.FC = () => {
  const menu = useUiStore((s) => s.contextMenu);
  if (!menu) return null;
  // Otro clic derecho = otro menú (posición y foco desde cero).
  return <MenuPanel key={`${menu.x}:${menu.y}:${menu.label}`} menu={menu} />;
};

const isAction = (item: MenuItem): item is Exclude<MenuItem, "separator"> => item !== "separator";

const MenuPanel: React.FC<{ menu: ContextMenuRequest }> = ({ menu }) => {
  const close = useUiStore((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y, ready: false });
  const [active, setActive] = useState(-1);
  // El foco vuelve a donde estaba (la fila del árbol, la pestaña) si se cierra sin elegir.
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  // Dentro de la ventana: si no cabe a la derecha o abajo, se abre hacia el otro lado.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = menu.x + width > window.innerWidth - EDGE ? Math.max(EDGE, menu.x - width) : menu.x;
    const top = menu.y + height > window.innerHeight - EDGE ? Math.max(EDGE, window.innerHeight - EDGE - height) : menu.y;
    setPosition({ left, top, ready: true });
  }, [menu]);

  // Con `visibility: hidden` no se puede enfocar: el foco entra cuando ya se ve.
  useEffect(() => {
    if (position.ready) ref.current?.focus();
  }, [position.ready]);

  useEffect(() => {
    const dismiss = () => close();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    // Esc aunque el foco esté en otro lado (p. ej. lo tomó la terminal).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || ref.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    // Captura: un mousedown que otro componente detiene también lo cierra.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("wheel", dismiss, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("wheel", dismiss);
    };
  }, [close]);

  const enabled = menu.items.flatMap((item, i) => (isAction(item) && !item.disabled ? [i] : []));

  const choose = (index: number) => {
    const item = menu.items[index];
    if (!item || !isAction(item) || item.disabled) return;
    close();
    item.onSelect();
  };

  const dismissKeepingFocus = () => {
    close();
    previousFocus.current?.focus();
  };

  const step = (delta: 1 | -1) => {
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    const next = at === -1 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    setActive(enabled[next]);
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menu.label}
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        // Las teclas son del menú: ni el visor (Esc lo cerraría) ni la terminal las ven.
        e.stopPropagation();
        if (e.key === "ArrowDown") step(1);
        else if (e.key === "ArrowUp") step(-1);
        else if (e.key === "Home") setActive(enabled[0] ?? -1);
        else if (e.key === "End") setActive(enabled[enabled.length - 1] ?? -1);
        else if (e.key === "Enter" || e.key === " ") choose(active);
        else if (e.key === "Escape" || e.key === "Tab") dismissKeepingFocus();
        else return;
        e.preventDefault();
      }}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
      className="fixed z-[70] min-w-[220px] max-w-[320px] animate-pop-in overflow-hidden rounded-lg border border-[var(--glass-border)] p-1 outline-none glass"
    >
      {menu.items.map((item, i) => {
        if (!isAction(item)) return <div key={`sep-${i}`} role="separator" className="mx-1.5 my-1 h-px bg-line" />;
        const Icon = item.icon;
        return (
          <button
            key={`${i}-${item.label}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            aria-disabled={item.disabled}
            onMouseEnter={() => setActive(item.disabled ? -1 : i)}
            onMouseLeave={() => setActive(-1)}
            onClick={() => choose(i)}
            className={cn(
              "flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-left text-[12.5px] transition-colors duration-100",
              item.disabled ? "text-ink-3/60" : "text-ink-2",
              active === i && "bg-hover text-ink",
            )}
          >
            {Icon ? (
              <Icon size={13} strokeWidth={1.75} aria-hidden="true" className={cn("shrink-0", active === i ? "text-accent" : "text-ink-3")} />
            ) : (
              <span className="w-[13px] shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <Kbd className="shrink-0">{item.hint}</Kbd>}
          </button>
        );
      })}
    </div>
  );
};

/** Abre el menú en el punto del clic derecho (y evita el del webview). */
export function showContextMenu(e: React.MouseEvent | MouseEvent, label: string, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useUiStore.getState().openContextMenu({ x: e.clientX, y: e.clientY, label, items });
}
