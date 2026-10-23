import React, { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { terminalManager } from "../terminal/TerminalManager";
import { IS_TAURI } from "../lib/ipc";
import { useSettingsStore } from "../store/settingsStore";
import { useTerminalStore } from "../store/terminalStore";

/** Una shell sana da su prompt en menos de esto; después, se dice qué la retiene. */
const PATIENCE_MS = 3000;

type Blocker = { name: string; command: string };

/** Lo más concreto que corre bajo la shell: el último hijo (el que de verdad espera). */
function describe(children: Blocker[]): string | null {
  const last = children[children.length - 1];
  if (!last) return null;
  const command = last.command.replace(/^\S*\//, "");
  return command && command !== last.name ? `${last.name} · ${command}` : last.name;
}

/**
 * Una shell que no da su prompt en 3 s: el panel dice cuánto lleva y qué la
 * retiene (algo de tu `.zshrc`: un `ng completion` que sale a la red, `nvm`,
 * `conda`…), en vez de quedarse mudo. Solo con la integración, que es la que
 * avisa del prompt; se va sola en cuanto llega.
 */
export const ShellStartup: React.FC<{ id: string; shellName: string }> = ({ id, shellName }) => {
  const [waiting, setWaiting] = useState<{ seconds: number; blocker: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let logged = false;
    let ticks = 0;
    let blocker: string | null = null;
    const timer = setInterval(() => {
      const state = terminalManager.startup(id);
      if (!state || state.ready) {
        if (state?.ready) {
          clearInterval(timer);
          // Quedó en el log cuánto tardó (si tardó): para ver después qué pasó.
          if (logged && IS_TAURI) {
            void logWarn(`[webview] ${shellName} dio su prompt tras ${((Date.now() - state.spawnedAt) / 1000).toFixed(1)} s`).catch(() => {});
          }
        }
        setWaiting(null);
        return;
      }
      const elapsed = Date.now() - state.spawnedAt;
      if (elapsed < PATIENCE_MS) return;
      // Los procesos se preguntan cada 2 s: lo que retiene a la shell rara vez cambia más rápido.
      if (ticks++ % 2 === 0) {
        void terminalManager.children(id).then((children) => {
          if (cancelled) return;
          blocker = describe(children);
          if (!logged && IS_TAURI) {
            logged = true;
            void logWarn(`[webview] ${shellName} lleva ${Math.round(elapsed / 1000)} s sin prompt; esperando a: ${blocker ?? "(nada visible: la propia shell)"}`).catch(() => {});
          }
        });
      }
      setWaiting({ seconds: Math.round(elapsed / 1000), blocker });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, shellName]);

  if (!waiting) return null;
  return (
    <div
      role="status"
      title={`Tu ${shellName} aún no termina de arrancar: algo de su configuración (~/.zshrc, ~/.zprofile) sigue corriendo y el prompt sale cuando acabe. Si sale a la red (telemetría, actualizaciones) o carga un gestor de versiones, cárgalo en diferido o desde un archivo.`}
      className="pointer-events-auto absolute inset-x-2 bottom-2 z-20 flex animate-pop-in items-center gap-2 rounded-md border border-warn/35 glass px-2.5 py-1.5 text-[11.5px]"
    >
      <Hourglass size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-warn" />
      <span className="shrink-0 text-ink">
        {shellName} lleva {waiting.seconds} s arrancando
      </span>
      {waiting.blocker && (
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">esperando a {waiting.blocker}</span>
      )}
    </div>
  );
};

/** La shell del panel, si su integración avisa del prompt (zsh y PowerShell); si no, no hay cómo saber cuándo arrancó. */
export function useWatchedShell(pane: { agentType?: unknown; command?: string; shell?: { name: string } }): string | null {
  const shells = useTerminalStore((s) => s.shells);
  const integration = useSettingsStore((s) => s.settings.shellIntegration);
  if (pane.agentType || pane.command || !integration) return null;
  const name = pane.shell?.name ?? shells?.find((s) => s.default)?.name ?? null;
  return name && /^(zsh|pwsh|powershell)$/i.test(name) ? name : null;
}
