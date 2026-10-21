import React, { useLayoutEffect, useRef } from "react";
import { Asterisk, Hexagon, SquareTerminal, type LucideIcon } from "lucide-react";
import type { PaneNode } from "../types/layout";
import { cn } from "../lib/layout";

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  size?: "md" | "sm";
  tone?: "default" | "danger";
  pressed?: boolean;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon: Icon,
  label,
  shortcut,
  size = "md",
  tone = "default",
  pressed,
  className,
  ...rest
}) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={pressed}
    title={shortcut ? `${label}  ${shortcut}` : label}
    className={cn(
      "grid shrink-0 place-items-center rounded-md transition-colors duration-150",
      size === "md" ? "size-7" : "size-6",
      pressed ? "bg-press text-ink" : "text-ink-3 hover:bg-hover hover:text-ink",
      tone === "danger" && "hover:bg-signal/15 hover:text-signal",
      className,
    )}
    {...rest}
  >
    <Icon size={size === "md" ? 15 : 13} strokeWidth={1.75} aria-hidden="true" />
  </button>
);

export const Kbd: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <kbd className={cn("font-mono text-[11px] tracking-wide text-ink-3", className)}>{children}</kbd>
);

/** Etiqueta de sección: versalitas discretas, con un dato a la derecha (p. ej. cuántas hay). */
export const SectionLabel: React.FC<{ children: React.ReactNode; aside?: React.ReactNode }> = ({
  children,
  aside,
}) => (
  <div className="flex items-center justify-between px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
    <span>{children}</span>
    {aside !== undefined && <span className="rounded-full bg-hover px-1.5 font-mono font-normal tabular-nums leading-4">{aside}</span>}
  </div>
);

export type LampState = "on" | "idle" | "off" | "attention";

export const Lamp: React.FC<{ state: LampState }> = ({ state }) => (
  <span
    className="lamp"
    data-state={state}
    role={state === "attention" ? "img" : undefined}
    aria-label={state === "attention" ? "Requiere atención" : undefined}
    aria-hidden={state === "attention" ? undefined : true}
  />
);

interface AgentGlyphProps {
  agentType: PaneNode["agentType"];
  className?: string;
}

/** Icono del tipo de panel. Componente estable (no se crea uno nuevo en cada render). */
export const AgentGlyph: React.FC<AgentGlyphProps> = ({ agentType, className }) => {
  const props = { size: 13, strokeWidth: 1.75, "aria-hidden": true, className } as const;
  if (agentType === "claude") return <Asterisk {...props} />;
  if (agentType === "codex") return <Hexagon {...props} />;
  return <SquareTerminal {...props} />;
};

interface MeterProps {
  value: number;
  label: string;
  segments?: number;
}

/** Medidor segmentado tipo VU: se lee de un vistazo y no depende solo del color. */
export const Meter: React.FC<MeterProps> = ({ value, label, segments = 24 }) => {
  const clamped = Math.min(Math.max(value, 0), 100);
  const filled = Math.round((clamped / 100) * segments);
  const critical = clamped >= 85;

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="flex h-1.5 gap-[2px]"
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={cn(
            "flex-1 rounded-[1px]",
            i < filled ? (critical ? "bg-signal" : "bg-accent") : "bg-line",
          )}
        />
      ))}
    </div>
  );
};

export type RingTone = "accent" | "warn" | "alert" | "muted";

/** Tono por umbral (el número va siempre escrito al lado: el color nunca es la única señal). */
export const toneFor = (percent: number): RingTone => (percent >= 90 ? "alert" : percent >= 75 ? "warn" : "accent");

const RING_COLOR: Record<RingTone, string> = {
  accent: "var(--color-accent)",
  warn: "var(--color-warn)",
  alert: "var(--color-signal)",
  muted: "var(--color-ink-3)",
};

interface RingProps {
  /** 0–100. */
  value: number;
  size?: number;
  stroke?: number;
  tone?: RingTone;
  /** Segundo anillo interior (p. ej. cuánto de la ventana de tiempo ya pasó), 0–100. */
  inner?: number | null;
  label?: string;
  children?: React.ReactNode;
}

/** Gauge radial: el uso como arco; opcionalmente, el tiempo transcurrido como arco interior. */
export const Ring: React.FC<RingProps> = ({ value, size = 16, stroke = 2, tone = toneFor(value), inner = null, label, children }) => {
  const clamp = (v: number) => Math.min(Math.max(v, 0), 100);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = stroke * 1.8;
  const ri = r - gap;
  const ci = 2 * Math.PI * ri;
  return (
    <span
      role={label ? "meter" : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label ? Math.round(clamp(value)) : undefined}
      aria-hidden={label ? undefined : true}
      className="relative inline-grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line-strong)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={RING_COLOR[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(clamp(value) / 100) * c} ${c}`}
          className="transition-[stroke-dasharray] duration-500 ease-out"
        />
        {inner !== null && ri > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={ri}
            fill="none"
            stroke="var(--color-ink-3)"
            strokeOpacity={0.55}
            strokeWidth={Math.max(1, stroke * 0.5)}
            strokeLinecap="round"
            strokeDasharray={`${(clamp(inner) / 100) * ci} ${ci}`}
          />
        )}
      </svg>
      {children && <span className="absolute inset-0 grid place-items-center">{children}</span>}
    </span>
  );
};

/**
 * El cursor de las listas que se recorren con el teclado (paleta, buscador,
 * ramas): una sola cápsula que se desliza a la fila activa, como el cursor de
 * una terminal entre líneas, con el prompt `»` del logo. Las filas no se pintan
 * a sí mismas, así que nada salta ni parpadea al moverse. Se posiciona sin
 * re-renderizar: transform sobre el nodo, medido en el layout de cada cambio.
 *
 * Va como hijo directo de la lista (`relative`), cuyas filas son `relative`
 * con `data-index`. La lista se toma del propio nodo y no de un ref del padre:
 * el layout effect de un hijo corre antes de que React asigne los refs del padre.
 * `layoutKey` cambia cuando cambian las filas (p. ej. el texto del filtro).
 */
export const PromptCursor: React.FC<{
  index: number;
  layoutKey?: unknown;
  /** `li` dentro de un `<ul>`: así el HTML sigue siendo válido. */
  as?: "span" | "li";
}> = ({ index, layoutKey, as = "span" }) => {
  const cursor = useRef<HTMLElement | null>(null);
  const glyph = useRef<HTMLSpanElement | null>(null);
  const lastIndex = useRef<number | null>(null);

  useLayoutEffect(() => {
    const node = cursor.current;
    const list = node?.parentElement;
    if (!node || !list) return;
    const place = () => {
      const row = list.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (!row) {
        node.style.opacity = "0";
        return;
      }
      node.style.transform = `translate3d(${row.offsetLeft}px, ${row.offsetTop}px, 0)`;
      node.style.width = `${row.offsetWidth}px`;
      node.style.height = `${row.offsetHeight}px`;
      node.style.opacity = "1";
    };
    place();
    const moved = lastIndex.current !== null && lastIndex.current !== index;
    lastIndex.current = index;
    let frame = 0;
    // Presencia del atributo, no su valor: `data-ready=""` es falsy y nunca pasaría al `else`.
    if (!("ready" in node.dataset)) {
      // La primera vez aparece en su sitio; desde ahí, se desliza.
      frame = requestAnimationFrame(() => {
        node.dataset.ready = "";
      });
    } else if (moved && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // El prompt se "reimprime" en la línea nueva.
      glyph.current?.animate(
        [
          { opacity: 0.2, transform: "translateX(-5px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
    const resize = new ResizeObserver(place);
    resize.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [index, layoutKey]);

  const Tag = as;
  return (
    <Tag ref={cursor as React.Ref<never>} className="prompt-cursor" aria-hidden="true" role={as === "li" ? "none" : undefined}>
      <span ref={glyph} className="prompt-glyph">
        »
      </span>
    </Tag>
  );
};

/** El `_` del logo parpadeando tras el texto de la fila activa: "esperando tu ↵". Sin ocupar sitio. */
export const PromptCaret: React.FC = () => <span className="prompt-caret" aria-hidden="true" />;
