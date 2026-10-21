import React, { useId } from "react";
import { LOGO_C, LOGO_CHEVRONS, LOGO_CURSOR, LOGO_T, LOGO_VIEWBOX } from "../lib/logo";
import { cn } from "../lib/layout";

interface LogoProps {
  className?: string;
  /** El cursor `_` parpadea (se respeta "reducir movimiento"). */
  blink?: boolean;
  /** Con nombre accesible (logo que informa); sin él es decorativo. */
  title?: string;
}

/** La marca `t»c_`: `t` y `c` en tinta (currentColor), `»_` en el color del tema con su brillo. */
export const LogoMark: React.FC<LogoProps> = ({ className, blink, title }) => {
  const glow = `logo-glow-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox={`0 0 ${LOGO_VIEWBOX.width} ${LOGO_VIEWBOX.height}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      overflow="visible"
      className={className}
    >
      <defs>
        {/* Filtro SVG nativo: WKWebView no aplica bien `filter` de CSS dentro de un SVG. */}
        <filter id={glow} x="-40%" y="-80%" width="180%" height="260%">
          <feDropShadow dx="0" dy="0" stdDeviation="16" style={{ floodColor: "var(--color-accent)", floodOpacity: 0.55 }} />
        </filter>
      </defs>
      <path d={LOGO_T} fill="currentColor" />
      <path d={LOGO_C} fill="currentColor" />
      <g filter={`url(#${glow})`} fill="var(--color-accent)" stroke="var(--color-accent)" strokeWidth={10} strokeLinejoin="round">
        {LOGO_CHEVRONS.map((points) => (
          <polygon key={points} points={points} />
        ))}
        <rect {...LOGO_CURSOR} strokeWidth={0} className={blink ? "logo-cursor-blink" : undefined} />
      </g>
    </svg>
  );
};

/** Marca + nombre (`termCode`) espaciado, como en el logo. */
export const Logo: React.FC<LogoProps & { size?: "sm" | "lg" }> = ({ size = "lg", className, ...rest }) => (
  <div className={cn("flex flex-col items-center", size === "lg" ? "gap-3" : "gap-1.5", className)}>
    <LogoMark {...rest} className={size === "lg" ? "h-14 w-auto text-ink" : "h-5 w-auto text-ink"} />
    <span
      className={cn(
        "font-mono font-bold text-ink",
        size === "lg" ? "text-[15px] tracking-[0.42em]" : "text-[10px] tracking-[0.32em]",
      )}
    >
      termCode
    </span>
  </div>
);
