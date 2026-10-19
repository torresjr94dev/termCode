import React, { useEffect, useRef } from "react";
import { useSettingsStore } from "../store/settingsStore";
import { useUiStore } from "../store/uiStore";
import { IS_MAC, shortcutLabel, type ShortcutId } from "../lib/shortcuts";
import { Kbd } from "./ui";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 px-4">
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
        className="w-full max-w-[600px] animate-pop-in overflow-hidden rounded-xl border border-line-strong bg-raised shadow-[0_32px_80px_-16px_rgb(0_0_0/0.75)]"
      >
        <div className="px-7 pb-2 pt-7">
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-amber">termCode</p>
          <h2 id="welcome-title" className="mt-2 text-[20px] font-medium leading-tight text-ink">
            Una terminal hecha para trabajar con agentes.
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            Cuatro atajos y ya conoces lo importante.{" "}
            {IS_MAC ? "Para ver todos: mantén ⌘ presionada medio segundo." : "Todos los demás están en la paleta."}
          </p>
        </div>
        <ul className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
          {TOUR.map((item) => (
            <li key={item.title} className="bg-raised px-7 py-4">
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
        <div className="flex items-center justify-between gap-3 border-t border-line bg-chrome px-7 py-4">
          <button type="button" onClick={() => finish(true)} className="text-[12.5px] text-ink-3 hover:text-ink-2">
            Ajustar tema y fuente
          </button>
          <button
            ref={startRef}
            type="button"
            onClick={() => finish()}
            className="h-8 rounded-md bg-amber px-4 text-[13px] font-medium text-on-amber transition-opacity duration-150 hover:opacity-90"
          >
            Empezar
          </button>
        </div>
      </div>
    </div>
  );
};
