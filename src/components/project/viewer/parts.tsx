import React from "react";
import { FileText, X } from "lucide-react";
import { closeViewer } from "../../../lib/project";
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
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-chrome pl-3 pr-1.5">
      <FileText size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="flex min-w-0 items-baseline gap-2 font-mono">
        <span className="shrink-0 text-[12.5px] text-ink">{name}</span>
        <span className="min-w-0 truncate text-[11px] text-ink-3">{dir}</span>
      </span>
      <span
        className={cn(
          "shrink-0 rounded-sm border px-1.5 font-mono text-[11px] leading-5",
          badgeTone === "accent" ? "border-accent/50 text-accent" : "border-line text-ink-3",
        )}
      >
        {badge}
      </span>
      <span className="flex-1" />
      {children}
      <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
      <IconButton icon={X} label="Cerrar" shortcut="esc" size="sm" onClick={closeViewer} />
    </div>
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
