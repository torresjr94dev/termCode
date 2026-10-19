import React from "react";
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

/** Etiqueta de sección: mayúsculas mono, discreta. */
export const SectionLabel: React.FC<{ children: React.ReactNode; aside?: React.ReactNode }> = ({
  children,
  aside,
}) => (
  <div className="flex items-center justify-between px-3 pb-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
    <span>{children}</span>
    {aside !== undefined && <span className="tabular-nums">{aside}</span>}
  </div>
);

export const Lamp: React.FC<{ state: "on" | "idle" | "off" }> = ({ state }) => (
  <span className="lamp" data-state={state} aria-hidden="true" />
);

export function agentIcon(agentType: PaneNode["agentType"]): LucideIcon {
  if (agentType === "claude") return Asterisk;
  if (agentType === "codex") return Hexagon;
  return SquareTerminal;
}

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
            i < filled ? (critical ? "bg-signal" : "bg-amber") : "bg-line",
          )}
        />
      ))}
    </div>
  );
};
