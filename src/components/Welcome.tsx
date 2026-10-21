import React, { useEffect, useRef } from "react";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { IS_MAC, shortcutLabel, type ShortcutId } from "../lib/shortcuts";
import { Kbd } from "./ui";
import { Logo } from "./Logo";

const TOUR: Array<{ keys: ShortcutId[]; title: string; detail: string }> = [
  { keys: ["palette"], title: "Todo está en la paleta", detail: "Cada acción de termCode, con su atajo al lado. Si dudas, empieza aquí." },
  { keys: ["splitRight", "splitDown"], title: "Paneles", detail: "Divide, maximiza y reordena. La sesión se restaura al volver a abrir." },
  { keys: ["projectChanges", "fileFinder"], title: "Tu repo, sin salir", detail: "Diffs por fragmento, commits con mensaje de IA, ramas, stash, conflictos y PRs." },
  { keys: ["missionControl"], title: "Agentes en paralelo", detail: "Claude Code y Codex con estado en vivo; revisa lo que cambiaron y compara worktrees." },
];

/** Solo la primera vez: lo esencial en una pantalla, y fuera. */
export const Welcome: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const done = useSettingsStore((s) => s.settings.onboardingDone);
  if (done) return null;
  return <WelcomeCard onClosed={onClosed} />;
};

const WelcomeCard: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const update = useSettingsStore((s) => s.update);
  const startRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    startRef.current?.focus();
  }, []);

  const finish = (openSettings = false) => {
    update({ onboardingDone: true });
    if (openSettings) useUiStore.getState().setSettingsOpen(true);
    else onClosed();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 px-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            finish();
          }
        }}
        className="relative w-full max-w-[600px] animate-pop-in overflow-hidden rounded-2xl border border-[var(--glass-border)] glass"
      >
        {/* El halo del logo: luz del color de marca detrás de la marca. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[420px] -translate-x-1/2 rounded-full bg-accent/15 blur-3xl"
        />
        <div className="relative flex flex-col items-center px-7 pb-3 pt-9 text-center">
          <Logo blink title="termCode" />
          <h2 id="welcome-title" className="mt-6 text-[20px] font-medium leading-tight text-ink">
            Una terminal hecha para trabajar con agentes.
          </h2>
          <p className="mt-2 max-w-[440px] text-[13px] leading-relaxed text-ink-3">
            Cuatro atajos y ya conoces lo importante.{" "}
            {IS_MAC ? "Para ver todos: mantén ⌘ presionada medio segundo." : "Todos los demás están en la paleta."}
          </p>
        </div>
        <ul className="relative mx-5 mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TOUR.map((item) => (
            <li key={item.title} className="rounded-xl border border-line bg-hover/40 px-4 py-3.5">
              <span className="flex gap-1">
                {item.keys.map((k) => (
                  <Kbd key={k}>{shortcutLabel(k)}</Kbd>
                ))}
              </span>
              <p className="mt-2 text-[13px] text-ink">{item.title}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{item.detail}</p>
            </li>
          ))}
        </ul>
        <div className="relative mt-5 flex items-center justify-between gap-3 border-t border-line px-7 py-4">
          <button type="button" onClick={() => finish(true)} className="text-[12.5px] text-ink-3 hover:text-ink-2">
            Ajustar tema y fuente
          </button>
          <button
            ref={startRef}
            type="button"
            onClick={() => finish()}
            className="h-9 rounded-full bg-accent px-5 text-[13px] font-semibold text-on-accent transition-opacity duration-150 hover:opacity-90"
          >
            Empezar
          </button>
        </div>
      </div>
    </div>
  );
};
