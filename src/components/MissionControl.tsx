import React, { useCallback, useEffect, useRef, useState } from "react";
import { Asterisk, Eye, Flag, GitBranch, GitMerge, Hexagon, Trash2, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { useProjectStore } from "../store/projectStore";
import { terminalManager } from "../terminal/TerminalManager";
import { actions, agentSpec, AGENTS, type AgentKind } from "../lib/actions";
import { gitApi } from "../lib/git";
import { openDiff, refreshStatus, reviewAgent } from "../lib/project";
import { basename, cn, collectPanes, tabLabel } from "../lib/layout";
import { formatAgo, formatUsd } from "../lib/format";
import { useNow } from "../lib/useNow";
import { shortcutLabel } from "../lib/shortcuts";
import type { AgentWorktree, PaneNode, Tab } from "../types/layout";
import { IconButton, Lamp } from "./ui";
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
      className="fixed inset-0 z-40 flex animate-fade-in flex-col bg-canvas outline-none"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
        <h2 className="text-[14px] font-medium text-ink">Agentes</h2>
        <span className="font-mono text-[12px] text-ink-3">{agents.length} abiertos</span>
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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
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

const AgentCard: React.FC<{ pane: PaneNode; tab: Tab; now: number; onGo: () => void }> = ({ pane, tab, now, onGo }) => {
  const activity = useTerminalStore((s) => s.agentActivity[pane.id]);
  const status = useTerminalStore((s) => s.agentStatus[pane.id]);
  const attention = useTerminalStore((s) => s.attention[pane.id]);
  const state = attention?.kind === "needs-input" ? "needs-input" : (activity?.state ?? "idle");
  const lines = terminalManager.snapshot(pane.id, 7);
  const cwd = terminalManager.knownCwd(pane.id) ?? pane.cwd;

  const go = () => {
    onGo();
    actions.focusPane(tab.id, pane.id);
  };

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-raised",
        state === "needs-input" ? "border-amber/70" : "border-line",
      )}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        {pane.agentType === "codex" ? (
          <Hexagon size={14} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
        ) : (
          <Asterisk size={14} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={pane.title}>
          {pane.title}
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-sm px-1.5 font-mono text-[11px] leading-5",
            state === "working" && "text-amber",
            state === "needs-input" && "bg-amber text-on-amber",
            state === "idle" && "text-ink-3",
          )}
        >
          {state !== "needs-input" && <Lamp state={state === "working" ? "on" : "off"} />}
          {STATE_LABEL[state] ?? state}
        </span>
      </header>

      <div className="flex flex-col gap-1 px-3 pt-2">
        <p className="truncate font-mono text-[12px] text-ink-2" title={activity?.detail}>
          {activity?.detail || (state === "idle" ? "Sin actividad registrada" : "…")}
        </p>
        <p className="flex flex-wrap gap-x-2 font-mono text-[11px] text-ink-3">
          {activity && <span>{formatAgo(activity.at, now)}</span>}
          {status?.model && <span>{status.model}</span>}
          {status?.contextPercent != null && (
            <span className={status.contextPercent >= 80 ? "text-amber" : undefined}>ctx {Math.round(status.contextPercent)}%</span>
          )}
          {status?.costUsd != null && <span>{formatUsd(status.costUsd)}</span>}
          {cwd && <span className="truncate">{basename(cwd)}</span>}
          {tabLabel(tab) !== pane.title && <span className="truncate">· {tabLabel(tab)}</span>}
        </p>
      </div>

      <pre
        aria-label="Últimas líneas"
        className="mx-3 mt-2 h-[108px] overflow-hidden rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[10.5px] leading-[15px] text-ink-3"
      >
        {lines.join("\n")}
      </pre>

      <footer className="mt-auto flex items-center gap-2 px-3 py-2.5">
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
  const askConfirm = useUiStore((s) => s.askConfirm);
  const toast = useUiStore((s) => s.showToast);

  const reload = useCallback(() => {
    gitApi
      .worktreeList(root)
      .then(setList)
      .catch(() => setList([]));
  }, [root]);

  useEffect(reload, [reload]);

  if (!list?.length) return null;

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
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-raised">
        {list.map((wt) => (
          <li key={wt.path} className="flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12.5px] text-ink">{wt.branch}</span>
              <span className="block truncate font-mono text-[11px] text-ink-3" title={wt.path}>
                {wt.changed} archivo{wt.changed === 1 ? "" : "s"} · <span className="text-add">+{wt.insertions}</span>{" "}
                <span className="text-del">−{wt.deletions}</span>
                {wt.commits > 0 && ` · ${wt.commits} commit${wt.commits === 1 ? "" : "s"}`} · {basename(wt.path)}
              </span>
            </span>
            <TextButton onClick={() => void review(wt)} disabled={!wt.changed}>
              <Eye size={13} aria-hidden="true" /> Ver
            </TextButton>
            <TextButton
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
                      .then(reload)
                      .catch((err) => toast(String(err), "error")),
                })
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
};

/* ------------------------------------------------------------------ */
/* Carrera: la misma tarea a varios agentes                            */
/* ------------------------------------------------------------------ */

const RaceDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const agentsInfo = useTerminalStore((s) => s.agents);
  const repo = useProjectStore((s) => s.repo);
  const toast = useUiStore((s) => s.showToast);
  const [prompt, setPrompt] = useState("");
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
    let launched = 0;
    try {
      for (const agent of ["claude", "codex"] as const) {
        for (let i = 0; i < planned(agent); i++) {
          const path = await gitApi.worktreeCreateFor(repo.root, agent);
          useTerminalStore.getState().createTab(agentSpec(agent, path, `${AGENTS[agent].title} · ${basename(path)}`, prompt));
          launched++;
        }
      }
      toast(`Carrera en marcha: ${launched} agente${launched === 1 ? "" : "s"}, cada uno en su worktree.`);
      onClose();
    } catch (err) {
      toast(`Se lanzaron ${launched}; luego falló: ${String(err)}`, "error");
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
      <div role="dialog" aria-modal="true" aria-labelledby="race-title" className="w-full max-w-[560px] animate-pop-in overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)]">
        <div className="border-b border-line px-4 py-3">
          <h2 id="race-title" className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Flag size={14} aria-hidden="true" className="text-amber" /> Carrera de agentes
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
