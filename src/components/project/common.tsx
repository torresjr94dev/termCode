import React from "react";
import { cn } from "../../lib/layout";

const LETTER_STYLE: Record<string, string> = {
  M: "text-accent",
  A: "text-add",
  U: "text-add",
  "?": "text-add",
  D: "text-del",
  R: "text-ink-2",
  C: "text-ink-2",
  T: "text-ink-2",
  "!": "text-signal",
};

const LETTER_NAME: Record<string, string> = {
  M: "Modificado",
  A: "Añadido",
  U: "Sin seguimiento",
  "?": "Sin seguimiento",
  D: "Eliminado",
  R: "Renombrado",
  C: "Copiado",
  T: "Tipo cambiado",
  "!": "En conflicto",
};

/** Letra de estado git: el color refuerza, la letra y el título bastan sin él. */
export const StatusLetter: React.FC<{ letter: string; className?: string }> = ({ letter, className }) => (
  <span
    title={LETTER_NAME[letter] ?? letter}
    className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", LETTER_STYLE[letter] ?? "text-ink-3", className)}
  >
    {letter}
  </span>
);

export const PanelSection: React.FC<{
  title: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, count, actions, children }) => (
  <section className="pb-2">
    <div className="group/section flex h-7 items-center gap-2 px-3 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
      <span>{title}</span>
      {count !== undefined && <span className="tabular-nums">{count}</span>}
      <span className="flex-1" />
      {actions}
    </div>
    {children}
  </section>
);

export const EmptyState: React.FC<{ icon?: React.ReactNode; title: string; detail?: string }> = ({ icon, title, detail }) => (
  <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
    {icon && <span className="text-ink-3">{icon}</span>}
    <p className="text-[13px] text-ink-2">{title}</p>
    {detail && <p className="text-[12px] leading-relaxed text-ink-3">{detail}</p>}
  </div>
);

export const TextButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" }> = ({
  tone = "default",
  className,
  children,
  ...rest
}) => (
  <button
    type="button"
    className={cn(
      "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
      tone === "primary"
        ? "bg-accent font-medium text-on-accent hover:opacity-90"
        : "border border-line text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink",
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

/** `src/lib/git.ts` → nombre + carpeta, para filas compactas. */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i === -1 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** `/Users/jorge/x` → `~/x`. */
export function tildify(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}
