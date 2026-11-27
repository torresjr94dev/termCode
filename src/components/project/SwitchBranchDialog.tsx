import React, { useEffect, useRef, useState } from "react";
import { GitBranch, TriangleAlert } from "lucide-react";
import { useProjectStore, type PendingSwitch } from "../../store/projectStore";
import { resolvePendingSwitch } from "../../lib/project";
import { basename, cn } from "../../lib/layout";
import { Kbd } from "../ui";

type Choice = "leave" | "bring";

/**
 * Cambiar de rama con cambios sin commit (como GitHub Desktop): o se quedan
 * guardados en la rama que dejas, o viajan contigo a la nueva. Llevarlos a
 * una rama existente puede chocar con lo que ella cambió: se avisa antes.
 */
export const SwitchBranchDialog: React.FC<{ onSettled: () => void }> = ({ onSettled }) => {
  const pending = useProjectStore((s) => s.pendingSwitch);
  if (!pending) return null;
  // Otra petición = el diálogo empieza de cero (opción por defecto y foco).
  return <Dialog key={`${pending.root}:${pending.name}`} pending={pending} onSettled={onSettled} />;
};

const MAX_FILES = 4;

const Dialog: React.FC<{ pending: PendingSwitch; onSettled: () => void }> = ({ pending, onSettled }) => {
  const target = pending.remote ? pending.name.replace(/^[^/]+\//, "") : pending.name;
  const from = pending.from ?? "este commit";
  // Rama nueva desde HEAD: llevarlos no puede chocar, y es lo que se suele querer.
  const [choice, setChoice] = useState<Choice>(pending.create ? "bring" : "leave");
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  // Solo al abrir: después el foco lo mueve quien usa el teclado.
  useEffect(() => {
    selectedRef.current?.focus();
  }, []);

  const settle = (mode: Choice | "cancel") => {
    void resolvePendingSwitch(mode);
    onSettled();
  };

  const count = pending.files.length;
  const shown = pending.files.slice(0, MAX_FILES).map(basename);
  const options: Array<{ id: Choice; title: string; body: string; risk?: string }> = [
    {
      id: "leave",
      title: `Dejar mis cambios en ${from}`,
      body: `Se guardan en el stash de ${from} (archivos nuevos incluidos). Cuando vuelvas a ${from}, te ofrezco restaurarlos.`,
    },
    {
      id: "bring",
      title: `Llevar mis cambios a ${target}`,
      body: pending.create
        ? `${target} nace de este mismo commit: tus cambios llegan tal cual.`
        : `Viajan contigo y siguen sin commit en ${target}.`,
      risk: pending.create
        ? undefined
        : `Si ${target} cambió los mismos archivos, quedarán conflictos por resolver (una copia queda en el stash por si acaso).`,
    },
  ];

  const move = (delta: 1 | -1) => {
    const i = options.findIndex((o) => o.id === choice);
    const next = options[(i + delta + options.length) % options.length].id;
    setChoice(next);
    // El foco sigue a la opción elegida (radio con flechas).
    requestAnimationFrame(() => selectedRef.current?.focus());
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle("cancel");
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          settle("cancel");
        } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement && e.target.dataset.action)) {
          e.preventDefault();
          settle(choice);
        }
      }}
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[14vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-title"
        aria-describedby="switch-body"
        className="w-full max-w-[460px] animate-pop-in overflow-hidden rounded-lg border border-[var(--glass-border)] glass"
      >
        <div className="px-4 pb-3 pt-4">
          <h2 id="switch-title" className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
            <GitBranch size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
            <span className="min-w-0 truncate">
              {pending.create ? "Crear y cambiar a " : "Cambiar a "}
              <span className="font-mono">{target}</span>
            </span>
          </h2>
          <p id="switch-body" className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
            Tienes {count === 1 ? "1 archivo" : `${count} archivos`} con cambios sin commit en{" "}
            <span className="font-mono text-ink">{from}</span>. ¿Qué hago con {count === 1 ? "él" : "ellos"}?
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-ink-3" title={pending.files.join("\n")}>
            {shown.join(" · ")}
            {count > MAX_FILES && ` · +${count - MAX_FILES}`}
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Qué hacer con tus cambios"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            }
          }}
          className="flex flex-col gap-2 px-4 pb-4"
        >
          {options.map((option) => {
            const selected = option.id === choice;
            return (
              <button
                key={option.id}
                ref={selected ? selectedRef : undefined}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setChoice(option.id)}
                onDoubleClick={() => settle(option.id)}
                className={cn(
                  "flex gap-3 rounded-md border p-3 text-left transition-colors duration-150",
                  selected ? "border-accent/70 bg-accent/[0.07]" : "border-line hover:border-line-strong hover:bg-hover",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                    selected ? "border-accent" : "border-line-strong",
                  )}
                >
                  {selected && <span className="size-2 rounded-full bg-accent shadow-none" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-ink">{option.title}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-2">{option.body}</span>
                  {option.risk && (
                    <span className="mt-1.5 flex gap-1.5 text-[11.5px] leading-relaxed text-warn">
                      <TriangleAlert size={12} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
                      {option.risk}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line bg-chrome px-3 py-2.5">
          <button
            type="button"
            data-action="cancel"
            onClick={() => settle("cancel")}
            className="flex h-7 items-center gap-2 rounded-md px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            Cancelar <Kbd>esc</Kbd>
          </button>
          <button
            type="button"
            data-action="confirm"
            onClick={() => settle(choice)}
            className="flex h-7 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-opacity duration-150 hover:opacity-90"
          >
            {pending.create ? "Crear rama" : "Cambiar de rama"} <Kbd className="text-on-accent/70">↵</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
};
