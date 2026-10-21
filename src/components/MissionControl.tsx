import React, { useCallback, useEffect, useRef, useState } from "react";
import { Asterisk, Eye, Flag, GitBranch, GitMerge, Hexagon, RotateCcw, Trash2, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { useProjectStore } from "../store/projectStore";
import { terminalManager } from "../terminal/TerminalManager";
import { actions, AGENTS, type AgentKind } from "../lib/actions";
import { gitApi } from "../lib/git";
import { openDiff, refreshStatus, reviewAgent } from "../lib/project";
import { basename, cn, collectPanes, tabLabel } from "../lib/layout";
import { formatAgo, formatDuration, formatUsd } from "../lib/format";
import { discardOthers, lastRaceCommand, raceScore, startRace, verifyEntry } from "../lib/race";
import { passed, useRaceStore, type VerifyState } from "../store/raceStore";
import { useNow } from "../lib/useNow";
import { IS_MAC, shortcutLabel } from "../lib/shortcuts";
import type { AgentWorktree, PaneNode, Tab } from "../types/layout";
import { IconButton, Lamp, Ring } from "./ui";
import { cleanTitle } from "../lib/identity";
import { TextButton } from "./project/common";

const STATE_LABEL: Record<string, string> = {
  working: "Trabajando",
  "needs-input": "Te necesita",
  idle: "Esperando instrucciones",
};

export const MissionControl: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const isOpen = useUiStore((s) => s.isMissionOpen);
  if (!isOpen) return null;
  return <MissionPanel onClosed={onClosed} />;
};

const MissionPanel: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const setOpen = useUiStore((s) => s.setMissionOpen);
  const repo = useProjectStore((s) => s.repo);
  const [racing, setRacing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const now = useNow(1000);

  const agents: Array<{ pane: PaneNode; tab: Tab }> = tabs.flatMap((tab) =>
    collectPanes(tab.root)
      .filter((pane) => pane.agentType)
      .map((pane) => ({ pane, tab })),
  );

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    onClosed();
  }, [setOpen, onClosed]);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Mission Control de agentes"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !racing) {
          e.preventDefault();
          close();
        }
      }}
      // A pantalla completa sobre las terminales: las difumina (no se leen a través del vidrio).
      className="fixed inset-0 z-40 flex animate-fade-in flex-col bg-canvas outline-none backdrop-blur-2xl"
    >
      {/* En macOS la cabecera deja sitio a los semáforos y sirve para arrastrar la ventana. */}
      <div data-tauri-drag-region className={cn("flex h-12 shrink-0 items-center gap-3 border-b border-line pr-4", IS_MAC ? "pl-[88px]" : "pl-5")}>
        <h2 className="text-[15px] font-semibold text-ink">Agentes</h2>
        <span className="rounded-full bg-hover px-2 font-mono text-[11px] leading-5 text-ink-2">{agents.length} abiertos</span>
        <span className="flex-1" />
        <TextButton onClick={() => setRacing(true)} disabled={!repo} title={repo ? undefined : "Abre un panel dentro de un repositorio git"}>
          <Flag size={13} strokeWidth={1.75} aria-hidden="true" /> Carrera de agentes
        </TextButton>
        <IconButton icon={X} label="Cerrar" shortcut={`esc · ${shortcutLabel("missionControl")}`} onClick={close} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {agents.length === 0 ? (
          <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 text-center">
            <p className="text-[14px] text-ink-2">No hay agentes abiertos.</p>
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              Lanza uno junto a tu panel, o una carrera: la misma tarea a varios agentes, cada uno en su worktree.
            </p>
            <div className="mt-2 flex gap-2">
              {(["claude", "codex"] as const).map((agent) => (
                <TextButton
                  key={agent}
                  onClick={() => {
                    close();
                    void actions.openAgentInSplit(agent);
                  }}
                >
                  {agent === "claude" ? <Asterisk size={13} aria-hidden="true" /> : <Hexagon size={13} aria-hidden="true" />}
                  {AGENTS[agent].title}
                </TextButton>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
            {agents.map(({ pane, tab }) => (
              <AgentCard key={pane.id} pane={pane} tab={tab} now={now} onGo={close} />
            ))}
          </div>
        )}

        {repo && <WorktreeSection root={repo.root} onReview={close} />}
      </div>

      {racing && <RaceDialog onClose={() => setRacing(false)} />}
    </div>
  );
};

const STATE_CHIP: Record<string, string> = {
  working: "bg-accent/15 text-accent",
  "needs-input": "bg-warn text-on-accent",
  idle: "bg-hover text-ink-3",
};

const AgentCard: React.FC<{ pane: PaneNode; tab: Tab; now: number; onGo: () => void }> = ({ pane, tab, now, onGo }) => {
  const activity = useTerminalStore((s) => s.agentActivity[pane.id]);
  const status = useTerminalStore((s) => s.agentStatus[pane.id]);
  const attention = useTerminalStore((s) => s.attention[pane.id]);
  const state = attention?.kind === "needs-input" ? "needs-input" : (activity?.state ?? "idle");
  // Las últimas líneas con contenido (sin el hueco de abajo que deja el TUI).
  const lines = terminalManager.snapshot(pane.id, 14).map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const cwd = terminalManager.knownCwd(pane.id) ?? pane.cwd;
  const title = cleanTitle(pane.title);
  const Glyph = pane.agentType === "codex" ? Hexagon : Asterisk;

  const go = () => {
    onGo();
    actions.focusPane(tab.id, pane.id);
  };

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border bg-raised transition-colors duration-150",
        state === "needs-input" ? "border-warn/60" : "border-line hover:border-line-strong",
      )}
    >
      <header className="flex items-center gap-3 px-4 pt-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
          <Glyph size={15} strokeWidth={1.9} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink" title={title}>
            {title}
          </span>
          <span className="block truncate font-mono text-[11px] text-ink-3">
            {[cwd ? basename(cwd) : null, tabLabel(tab) !== pane.title ? tabLabel(tab) : null].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium leading-6", STATE_CHIP[state] ?? STATE_CHIP.idle)}>
          {state === "working" && <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />}
          {STATE_LABEL[state] ?? state}
        </span>
      </header>

      <div className="flex items-center gap-3 px-4 pt-3">
        {status?.contextPercent != null ? (
          <Ring value={status.contextPercent} size={40} stroke={3.5} label={`Contexto usado: ${Math.round(status.contextPercent)} %`}>
            <span className="font-mono text-[10.5px] font-semibold tabular-nums text-ink">{Math.round(status.contextPercent)}</span>
          </Ring>
        ) : (
          <Ring value={0} size={40} stroke={3.5} tone="muted" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12px] text-ink-2" title={activity?.detail}>
            {activity?.detail || (state === "idle" ? "Sin actividad registrada" : "…")}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink-3">
            {status?.model && <span className="rounded-full bg-hover px-2 leading-5 text-ink-2">{status.model}</span>}
            {status?.costUsd != null && <span className="rounded-full bg-hover px-2 leading-5">{formatUsd(status.costUsd)}</span>}
            {activity && <span>{formatAgo(activity.at, now)}</span>}
          </p>
        </div>
      </div>

      <pre
        aria-label="Últimas líneas"
        className="mx-4 mt-3 h-[96px] overflow-hidden whitespace-pre rounded-xl bg-canvas px-3 py-2 font-mono text-[10.5px] leading-[15px] text-ink-3 [mask-image:linear-gradient(to_bottom,transparent,black_35%)]"
      >
        {lines.slice(-6).join("\n") || " "}
      </pre>

      <footer className="flex items-center gap-2 px-4 py-3">
        <TextButton tone="primary" onClick={go}>
          Ir al panel
        </TextButton>
        {/* Las fotos del repo las toman los hooks de Claude Code; Codex no tiene. */}
        {pane.agentType === "claude" && (
          <>
            <TextButton
              onClick={() => {
                void reviewAgent(pane.id, "turn").then((opened) => opened && onGo());
              }}
              title="Todo lo que cambió desde tu último mensaje al agente"
            >
              <Eye size={13} strokeWidth={1.75} aria-hidden="true" /> Revisar cambios
            </TextButton>
            <button
              type="button"
              onClick={() => {
                void reviewAgent(pane.id, "session").then((opened) => opened && onGo());
              }}
              className="ml-auto text-[11.5px] text-ink-3 hover:text-ink-2"
            >
              toda la sesión
            </button>
          </>
        )}
      </footer>
    </article>
  );
};

/* ------------------------------------------------------------------ */
/* Worktrees de agentes                                                */
/* ------------------------------------------------------------------ */

const WorktreeSection: React.FC<{ root: string; onReview: () => void }> = ({ root, onReview }) => {
  const [list, setList] = useState<AgentWorktree[] | null>(null);
  const [outputOf, setOutputOf] = useState<string | null>(null);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const toast = useUiStore((s) => s.showToast);
  const race = useRaceStore((s) => s.race);
  const agentStatus = useTerminalStore((s) => s.agentStatus);
  const agentActivity = useTerminalStore((s) => s.agentActivity);
  const now = useNow(1000);

  const reload = useCallback(() => {
    gitApi
      .worktreeList(root)
      .then(setList)
      .catch(() => setList([]));
  }, [root]);

  // Los agentes siguen escribiendo mientras miras: las cifras se refrescan solas.
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!list?.length) return null;
  const entryFor = (path: string) => race?.entries.find((e) => e.worktree === path);

  /** Ganador aplicado: ofrecer cerrar y borrar al resto de la carrera. */
  const offerDiscard = (winner: AgentWorktree) => {
    const others = race?.entries.filter((e) => e.worktree !== winner.path) ?? [];
    if (!entryFor(winner.path) || !others.length) return;
    askConfirm({
      title: `¿Descartar a los otros ${others.length}?`,
      body: `Se cierran sus agentes y se borran sus worktrees y ramas (${others.map((e) => basename(e.worktree)).join(", ")}). Lo que no aplicaste de ellos se pierde.`,
      confirmLabel: "Descartar al resto",
      onConfirm: () =>
        void discardOthers(root, winner.path).then((n) => {
          toast(`Listo: ${n} worktree${n === 1 ? "" : "s"} descartado${n === 1 ? "" : "s"}.`);
          reload();
        }),
    });
  };

  const review = async (wt: AgentWorktree) => {
    try {
      const files = await gitApi.reviewFiles(wt.path, wt.base, []);
      if (!files.length) {
        toast("Ese worktree no tiene cambios.");
        return;
      }
      const sources = files.map((f) => ({
        kind: "review" as const,
        base: wt.base,
        path: f.path,
        origPath: f.origPath,
        created: f.status === "A" && !f.origPath,
        root: wt.path,
        label: wt.branch.replace("termcode/", ""),
      }));
      onReview();
      await openDiff(sources[0], sources);
    } catch (err) {
      toast(String(err), "error");
    }
  };

  return (
    <section className="mt-8">
      <h3 className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
        <GitBranch size={12} aria-hidden="true" /> Worktrees de agentes
      </h3>
      {race && <RaceHeader />}
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-raised">
        {list.map((wt) => {
          const entry = entryFor(wt.path);
          const cost = entry ? agentStatus[entry.paneId]?.costUsd : null;
          const state = entry ? agentActivity[entry.paneId]?.state : undefined;
          const verify = entry?.verify;
          const canVerify = Boolean(race?.command && entry && verify?.status !== "queued" && verify?.status !== "running");
          return (
            <li key={wt.path} className="px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px] text-ink">{wt.branch}</span>
                  <span className="block truncate font-mono text-[11px] text-ink-3" title={wt.path}>
                    {wt.changed} archivo{wt.changed === 1 ? "" : "s"} · <span className="text-add">+{wt.insertions}</span>{" "}
                    <span className="text-del">−{wt.deletions}</span>
                    {wt.commits > 0 && ` · ${wt.commits} commit${wt.commits === 1 ? "" : "s"}`} · {basename(wt.path)}
                  </span>
                  {entry && (
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-ink-3">
                      {race?.command && verify && <VerifyBadge verify={verify} now={now} />}
                      {state && <span>{STATE_LABEL[state] ?? state}</span>}
                      {cost != null && <span>{formatUsd(cost)}</span>}
                      {(verify?.status === "done" || verify?.status === "error") && (
                        <button
                          type="button"
                          aria-expanded={outputOf === wt.path}
                          onClick={() => setOutputOf(outputOf === wt.path ? null : wt.path)}
                          className="text-ink-3 underline decoration-line underline-offset-2 hover:text-ink-2"
                        >
                          {outputOf === wt.path ? "ocultar salida" : "ver salida"}
                        </button>
                      )}
                    </span>
                  )}
                </span>
                {canVerify && (
                  <IconButton icon={RotateCcw} size="sm" label={`Verificar de nuevo (${race?.command})`} onClick={() => verifyEntry(wt.path)} />
                )}
                <TextButton onClick={() => void review(wt)} disabled={!wt.changed}>
                  <Eye size={13} aria-hidden="true" /> Ver
                </TextButton>
                <TextButton
                  tone={verify && passed(verify) ? "primary" : undefined}
                  disabled={!wt.changed}
                  onClick={() =>
                    askConfirm({
                      title: `¿Traer el trabajo de ${wt.branch} a tu rama?`,
                      body: "Todo lo que hizo desde que se bifurcó (commits incluidos) llega a tu árbol de trabajo sin commitear, con fusión de 3 vías si hace falta.",
                      confirmLabel: "Aplicar",
                      onConfirm: () =>
                        void gitApi
                          .worktreeApply(wt.path, root)
                          .then((n) => {
                            toast(`Aplicados ${n} archivo${n === 1 ? "" : "s"} de ${wt.branch}.`);
                            void refreshStatus();
                            offerDiscard(wt);
                          })
                          .catch((err) => toast(String(err), "error")),
                    })
                  }
                >
                  <GitMerge size={13} aria-hidden="true" /> Aplicar a mi rama
                </TextButton>
            <IconButton
              icon={Trash2}
              tone="danger"
              size="sm"
              label={`Eliminar ${wt.branch}`}
              onClick={() =>
                askConfirm({
                  title: `¿Eliminar ${wt.branch}?`,
                  body: "Se borran el worktree y su rama. Lo que no hayas aplicado se pierde.",
                  confirmLabel: "Eliminar",
                  onConfirm: () =>
                    void gitApi
                      .worktreeRemove(root, wt.path)
                      .then(() => {
                        useRaceStore.getState().forget([wt.path]);
                        reload();
                      })
                      .catch((err) => toast(String(err), "error")),
                })
              }
            />
              </div>
              {outputOf === wt.path && verify && (verify.status === "done" || verify.status === "error") && (
                <pre
                  aria-label={`Salida de ${race?.command ?? "la verificación"}`}
                  className="mt-2 max-h-[280px] select-text overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[10.5px] leading-[15px] text-ink-2"
                >
                  {verify.status === "done" ? verify.output || "(sin salida)" : verify.message}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** «Carrera · 2 de 3 pasan `pnpm test`»: la tarea, el juez y el marcador. */
const RaceHeader: React.FC = () => {
  const race = useRaceStore((s) => s.race);
  const clear = useRaceStore((s) => s.clear);
  if (!race) return null;
  const score = raceScore(race.entries);
  return (
    <div className="mb-2 flex items-start gap-3 rounded-lg border border-accent/40 bg-accent/[0.05] px-3 py-2.5">
      <Flag size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink">
          <span className="font-medium">Carrera</span>
          {race.command ? (
            <span className="text-ink-2">
              {score.judged ? `${score.passed} de ${score.total} pasan` : "nadie ha terminado aún"} ·{" "}
              <span className="font-mono text-[11.5px] text-ink-3">{race.command}</span>
            </span>
          ) : (
            <span className="text-ink-3">sin juez: compara los diffs</span>
          )}
        </p>
        <p className="mt-0.5 truncate text-[11.5px] text-ink-3" title={race.prompt}>
          «{race.prompt}»
        </p>
      </div>
      <button type="button" onClick={clear} title="Deja de seguir la carrera (los worktrees se quedan)" className="shrink-0 text-[11.5px] text-ink-3 hover:text-ink-2">
        Terminar
      </button>
    </div>
  );
};

const VerifyBadge: React.FC<{ verify: VerifyState; now: number }> = ({ verify, now }) => {
  switch (verify.status) {
    case "pending":
      return <span>sin verificar</span>;
    case "queued":
      return <span>en cola</span>;
    case "running":
      return (
        <span className="flex items-center gap-1.5 text-accent">
          <Lamp state="on" /> verificando · {formatDuration(Math.max(0, now - verify.startedAt))}
        </span>
      );
    case "error":
      return (
        <span className="text-signal" title={verify.message}>
          error al verificar
        </span>
      );
    default:
      return verify.code === 0 ? (
        <span className="text-add">✓ pasa · {formatDuration(verify.durationMs)}</span>
      ) : (
        <span className="text-del">
          ✗ {verify.timedOut ? "tiempo agotado" : `falla (código ${verify.code ?? "?"})`} · {formatDuration(verify.durationMs)}
        </span>
      );
  }
};

/* ------------------------------------------------------------------ */
/* Carrera: la misma tarea a varios agentes                            */
/* ------------------------------------------------------------------ */

const RaceDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const agentsInfo = useTerminalStore((s) => s.agents);
  const repo = useProjectStore((s) => s.repo);
  const toast = useUiStore((s) => s.showToast);
  const [prompt, setPrompt] = useState("");
  const [command, setCommand] = useState(lastRaceCommand);
  const [counts, setCounts] = useState<Record<AgentKind, number>>({ claude: 2, codex: agentsInfo?.codex ? 1 : 0 });
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const planned = (agent: AgentKind) => (agentsInfo?.[agent] ? counts[agent] : 0);
  const total = planned("claude") + planned("codex");

  const start = async () => {
    if (!repo || !prompt.trim() || !total) return;
    setBusy(true);
    try {
      const launched = await startRace({
        root: repo.root,
        prompt,
        command,
        plan: { claude: planned("claude"), codex: planned("codex") },
      });
      const judge = command.trim() ? ` Cuando cada uno termine, se corre «${command.trim()}» en su worktree.` : "";
      toast(`Carrera en marcha: ${launched} agente${launched === 1 ? "" : "s"}, cada uno en su worktree.${judge}`);
      onClose();
    } catch (err) {
      toast(`La carrera no arrancó completa: ${String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/60 px-4 pt-[12vh]"
    >
      <div role="dialog" aria-modal="true" aria-labelledby="race-title" className="w-full max-w-[560px] animate-pop-in overflow-hidden rounded-lg border border-[var(--glass-border)] glass">
        <div className="border-b border-line px-4 py-3">
          <h2 id="race-title" className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Flag size={14} aria-hidden="true" className="text-accent" /> Carrera de agentes
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
            Cada agente trabaja en su propio worktree (rama <span className="font-mono">termcode/…</span>) a partir de tu HEAD. Luego
            comparas en Mission Control y traes a tu rama el que mejor lo resolvió.
          </p>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-2">
            Tarea
            <textarea
              ref={textRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder="Ej.: Agrega paginación al endpoint /users con tests."
              className="select-text resize-y rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-line-strong"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-2">
            <span>
              Juez <span className="text-ink-3">(opcional)</span>
            </span>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              maxLength={2000}
              spellCheck={false}
              placeholder="pnpm test"
              className="h-8 select-text rounded-md border border-line bg-canvas px-2.5 font-mono text-[12.5px] text-ink outline-none focus:border-line-strong"
            />
            <span className="text-[11.5px] leading-relaxed text-ink-3">
              Tu comando, en el worktree de cada agente cada vez que termina un turno. De uno en uno (los tests chocan si van en
              paralelo), con <span className="font-mono">CI=1</span>.
            </span>
          </label>
          <div className="flex gap-4">
            {(["claude", "codex"] as const).map((agent) => {
              const installed = Boolean(agentsInfo?.[agent]);
              return (
                <label key={agent} className={cn("flex items-center gap-2 text-[12.5px]", installed ? "text-ink-2" : "text-ink-3/60")}>
                  {AGENTS[agent].title}
                  <select
                    disabled={!installed}
                    value={installed ? counts[agent] : 0}
                    onChange={(e) => setCounts((c) => ({ ...c, [agent]: Number(e.target.value) }))}
                    className="h-7 rounded border border-line bg-canvas px-1.5 font-mono text-[12px] text-ink"
                  >
                    {[0, 1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        ×{n}
                      </option>
                    ))}
                  </select>
                  {!installed && <span className="text-[11px]">no instalado</span>}
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-chrome px-4 py-3">
          <TextButton onClick={onClose}>Cancelar</TextButton>
          <TextButton tone="primary" onClick={() => void start()} disabled={busy || !prompt.trim() || !total}>
            {busy ? "Preparando worktrees…" : `Lanzar ${total} agente${total === 1 ? "" : "s"}`}
          </TextButton>
        </div>
      </div>
    </div>
  );
};
