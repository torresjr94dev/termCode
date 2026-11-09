import React from "react";
import { Columns2, FileText, Maximize2, X } from "lucide-react";
import { useProjectStore } from "../../../store/projectStore";
import { closeViewer, toggleViewerDock } from "../../../lib/project";
import type { Segment } from "../../../lib/highlight";
import { cn } from "../../../lib/layout";
import { IconButton } from "../../ui";
import { splitPath } from "../common";

export const Header: React.FC<{ path: string; badge: string; badgeTone?: "accent"; children?: React.ReactNode }> = ({
  path,
  badge,
  badgeTone,
  children,
}) => {
  const { name, dir } = splitPath(path);
  return (
    // Angosto (visor acoplado): el nombre se recorta y lo accesorio se esconde; cerrar siempre se ve.
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-chrome pl-3 pr-1.5 @xl:gap-3">
      <FileText size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="flex min-w-[4ch] items-baseline gap-2 font-mono" title={path}>
        <span className="min-w-0 truncate text-[12.5px] text-ink">{name}</span>
        <span className="hidden min-w-0 truncate text-[11px] text-ink-3 @2xl:inline">{dir}</span>
      </span>
      <span
        className={cn(
          // Angosto se esconde: «sin guardar» ya lo dicen el punto de la pestaña y el botón Guardar.
          "hidden shrink-0 rounded-sm border px-1.5 font-mono text-[11px] leading-5 @lg:inline",
          badgeTone === "accent" ? "border-accent/50 text-accent" : "border-line text-ink-3",
        )}
      >
        {badge}
      </span>
      <span className="flex-1" />
      <div className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">{children}</div>
      <span className="mx-1 h-4 w-px shrink-0 bg-line" aria-hidden="true" />
      <DockToggle />
      <IconButton icon={X} label="Cerrar" shortcut="esc" size="sm" onClick={closeViewer} />
    </div>
  );
};

/** Ver el archivo junto a las terminales (y al agente que lo edita) o encima de ellas. */
export const DockToggle: React.FC = () => {
  const docked = useProjectStore((s) => s.viewerDock.docked);
  return (
    <IconButton
      icon={docked ? Maximize2 : Columns2}
      label={docked ? "Ver encima de las terminales" : "Ver junto a las terminales"}
      size="sm"
      pressed={docked}
      onClick={toggleViewerDock}
    />
  );
};

export const Body: React.FC<{ bodyRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }> = ({ bodyRef, children }) => (
  <div ref={bodyRef} tabIndex={-1} className="min-h-0 flex-1 select-text overflow-auto font-mono text-[12px] leading-[20px] outline-none">
    {children}
  </div>
);

export const Notice: React.FC<{ children: React.ReactNode; tone?: "error" }> = ({ children, tone }) => (
  <p className={cn("px-4 py-6 font-sans text-[13px]", tone === "error" ? "text-signal" : "text-ink-3")}>{children}</p>
);

/** Segmentos coloreados (texto plano: React lo escapa). */
export const Segments: React.FC<{ segments: Segment[] }> = ({ segments }) => (
  <>
    {segments.map((s, i) =>
      s.cls ? (
        <span key={i} className={s.cls}>
          {s.text}
        </span>
      ) : (
        <React.Fragment key={i}>{s.text}</React.Fragment>
      ),
    )}
  </>
);
