import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Asterisk, FileSearch, Hexagon, LayoutGrid, Search } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { actions } from "../lib/actions";
import { pace } from "../lib/quota";
import { cn } from "../lib/layout";
import { IS_MAC, shortcutLabel, type ShortcutId } from "../lib/shortcuts";
import { useNow } from "../lib/useNow";
import type { WelcomeView } from "../terminal/TerminalManager";
import { LogoMark } from "./Logo";
import { Kbd, Ring, toneFor } from "./ui";
import { tildify } from "../lib/paths";

interface WelcomeCardProps {
  cwd: string | null;
  home: string | null;
  user: string | null;
  version: string;
  compact: boolean;
  view: WelcomeView;
}

function greeting(now: Date): string {
  const hour = now.getHours();
  return hour < 6 ? "Buenas noches" : hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
}


/**
 * Bienvenida de una pestaña nueva: una tarjeta real (logo, datos, atajos)
 * flotando sobre unas líneas en blanco de la terminal. Al dividir o cambiar
 * el tamaño se reacomoda en vez de partirse como lo haría un texto.
 */
const WelcomeCard: React.FC<WelcomeCardProps> = ({ cwd, home, user, version, compact, view }) => {
  const width = useSyncExternalStore(view.onResize, view.width);
  const agents = useTerminalStore((s) => s.agents);
  const usage = useTerminalStore((s) => s.usage);
  const nowMs = useNow(60_000);
  const now = new Date(nowMs);
  const narrow = width < 640;

  const quota = (["claude", "codex"] as const).flatMap((id) => {
    const provider = usage[id];
    const session = provider.status === "ok" ? provider.windows.find((w) => w.kind === "session") : undefined;
    return session ? [{ id, name: id === "claude" ? "Claude" : "Codex", value: session.usedPercent, elapsed: pace(session, nowMs)?.elapsedPercent ?? null }] : [];
  });

  const quick: Array<{ id: ShortcutId; label: string; icon: typeof Search; run: () => void }> = [
    { id: "palette", label: "Comandos", icon: Search, run: () => useUiStore.getState().setPaletteOpen(true) },
    { id: "missionControl", label: "Agentes", icon: LayoutGrid, run: () => useUiStore.getState().setMissionOpen(true) },
    { id: "fileFinder", label: "Buscar archivo", icon: FileSearch, run: () => useUiStore.getState().setFinderOpen(true) },
  ];
  // La tarjeta tiene alto fijo: lo que no quepa en su fila se recorta. Fuera de
  // macOS los atajos son largos (Ctrl+Shift+Alt+A) y en angosto dos botones ya
  // no caben en una fila; la paleta lleva a todo lo demás.
  const quickCount = compact || narrow ? (IS_MAC ? 2 : 1) : 3;

  return (
    <div
      // Los clics de la tarjeta no llegan a la terminal (no inician una selección).
      onMouseDown={(e) => e.stopPropagation()}
      style={{ width: Math.max(0, width - 28) }}
      className="welcome-card glass relative h-full max-w-[860px] overflow-hidden rounded-2xl border font-sans"
    >
      <div aria-hidden="true" className="pointer-events-none absolute -left-16 -top-24 h-56 w-72 rounded-full bg-accent/15 blur-3xl" />
      <div className={cn("relative flex h-full items-center", compact ? "gap-4 px-4" : narrow ? "gap-5 px-5" : "gap-7 px-7")}>
        <div className={cn("flex shrink-0 flex-col", compact ? "items-start" : "items-center")}>
          <LogoMark blink title="termCode" className={cn("w-auto text-ink", compact ? "h-6" : "h-11")} />
          {!compact && (
            <>
              <span className="mt-2.5 font-mono text-[11.5px] font-bold tracking-[0.38em] text-ink">termCode</span>
              <span className="mt-0.5 text-[10.5px] text-ink-3">by CODERGENIUS MX</span>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {!compact && (
            <div className="min-w-0">
              <p className="truncate text-[15px] font-medium text-ink">
                {greeting(now)}
                {user ? `, ${user}` : ""}
              </p>
              <p className="truncate text-[12px] text-ink-3">
                {now.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })} ·{" "}
                {now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })} · v{version}
              </p>
            </div>
          )}

          {!compact && (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {agents &&
                (["claude", "codex"] as const).map((id) => {
                  const installed = Boolean(agents[id]);
                  const Icon = id === "claude" ? Asterisk : Hexagon;
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={!installed}
                      onClick={() => void actions.openAgentInSplit(id)}
                      title={installed ? `Abrir ${id === "claude" ? "Claude Code" : "Codex"} junto a este panel` : "No instalado"}
                      className={cn(
                        "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors duration-150",
                        installed ? "glass-pill text-ink-2 hover:text-ink" : "bg-hover text-ink-3",
                      )}
                    >
                      <Icon size={12} strokeWidth={1.9} aria-hidden="true" className={installed ? "text-accent" : undefined} />
                      {id === "claude" ? "Claude Code" : "Codex"}
                      {!installed && <span className="text-[11px]">· no instalado</span>}
                    </button>
                  );
                })}
              {quota.map((q) => (
                <span
                  key={q.id}
                  title={`${q.name}: ${Math.round(q.value)} % de la sesión de 5 h`}
                  className="flex h-7 items-center gap-1.5 rounded-full bg-hover pl-1.5 pr-2.5 font-mono text-[11.5px] tabular-nums text-ink-2"
                >
                  <Ring value={q.value} inner={q.elapsed} size={18} stroke={2.25} tone={toneFor(q.value)} />
                  {q.name} {Math.round(q.value)}%
                </span>
              ))}
              {cwd && !narrow && (
                <span className="min-w-0 truncate rounded-full bg-hover px-2.5 font-mono text-[11.5px] leading-7 text-ink-3" title={cwd}>
                  {tildify(cwd, home)}
                </span>
              )}
            </div>
          )}

          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {quick.slice(0, quickCount).map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={q.run}
                className="flex h-7 items-center gap-2 rounded-full border border-line px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:border-accent/50 hover:text-ink"
              >
                <q.icon size={12} strokeWidth={1.9} aria-hidden="true" className="text-ink-3" />
                {q.label}
                <Kbd className="text-[10.5px]">{shortcutLabel(q.id)}</Kbd>
              </button>
            ))}
            {compact && <span className="truncate text-[11px] text-ink-3">termCode · by CODERGENIUS MX</span>}
          </div>
        </div>
      </div>
    </div>
  );
};

/** Monta la tarjeta en el elemento de la decoración de xterm; devuelve cómo desmontarla. */
export function mountWelcomeCard(host: HTMLElement, props: WelcomeCardProps): () => void {
  const root = createRoot(host);
  root.render(<WelcomeCard {...props} />);
  return () => root.unmount();
}
