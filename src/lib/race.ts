import { passed, useRaceStore, type RaceEntry } from "../store/raceStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { agentSpec, AGENTS, type AgentKind } from "./actions";
import { gitApi, type VerifyResult } from "./git";
import { basename } from "./layout";
import { formatDuration } from "./format";
import { notify } from "./bridge";

const COMMAND_KEY = "termcode.raceCommand";

/** El último comando de verificación que usaste (comodidad por equipo, no estado importante). */
export function lastRaceCommand(): string {
  try {
    return localStorage.getItem(COMMAND_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberCommand(command: string) {
  try {
    localStorage.setItem(COMMAND_KEY, command);
  } catch {
    // Sin almacenamiento: solo no se recuerda para la próxima.
  }
}

/**
 * La misma tarea a varios agentes, cada uno en su worktree. Devuelve cuántos
 * arrancaron (si uno falla, los anteriores siguen en marcha).
 */
export async function startRace(opts: { root: string; prompt: string; command: string; plan: Partial<Record<AgentKind, number>> }) {
  const command = opts.command.trim();
  rememberCommand(command);
  const entries: RaceEntry[] = [];
  const race = { id: `race-${Date.now()}`, prompt: opts.prompt.trim(), command: command || null, startedAt: Date.now(), entries };
  try {
    for (const agent of ["claude", "codex"] as const) {
      for (let i = 0; i < (opts.plan[agent] ?? 0); i++) {
        const path = await gitApi.worktreeCreateFor(opts.root, agent);
        const terminals = useTerminalStore.getState();
        terminals.createTab(agentSpec(agent, path, `${AGENTS[agent].title} · ${basename(path)}`, race.prompt));
        const tab = useTerminalStore.getState().tabs.at(-1);
        if (tab) entries.push({ paneId: tab.activePaneId, agent, worktree: path, verify: { status: "pending" } });
      }
    }
  } finally {
    // Lo que sí arrancó entra a la carrera aunque luego algo fallara.
    if (entries.length) useRaceStore.getState().start({ ...race, entries: [...entries] });
  }
  return entries.length;
}

/* ------------------------------------------------------------------ */
/* El juez: una verificación a la vez                                  */
/* ------------------------------------------------------------------ */

let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/** Corre el comando de la carrera en ese worktree (en cola: los tests chocan si van en paralelo). */
export function verifyEntry(worktree: string) {
  const race = useRaceStore.getState().race;
  const command = race?.command;
  if (!command || queued.has(worktree) || !race.entries.some((e) => e.worktree === worktree)) return;
  queued.add(worktree);
  useRaceStore.getState().setVerify(worktree, { status: "queued" });
  queue = queue.then(async () => {
    const store = useRaceStore.getState();
    // La carrera pudo cambiar o borrarse mientras esperaba.
    if (store.race?.command !== command || !store.race.entries.some((e) => e.worktree === worktree)) {
      queued.delete(worktree);
      return;
    }
    store.setVerify(worktree, { status: "running", startedAt: Date.now() });
    let result: VerifyResult;
    try {
      result = await gitApi.worktreeVerify(worktree, command);
    } catch (err) {
      useRaceStore.getState().setVerify(worktree, { status: "error", message: String(err), at: Date.now() });
      return;
    } finally {
      queued.delete(worktree);
    }
    // El veredicto se guarda antes de avisar: un aviso que falle no puede pisarlo.
    useRaceStore.getState().setVerify(worktree, { status: "done", ...result, at: Date.now() });
    announce(worktree, command, result.code === 0, result.timedOut ? "se agotó el tiempo" : formatDuration(result.durationMs));
  });
}

function announce(worktree: string, command: string, ok: boolean, detail: string) {
  const text = `Carrera · ${basename(worktree)}: ${ok ? "✓ pasó" : "✗ no pasó"} ${command} (${detail})`;
  try {
    if (!useUiStore.getState().isMissionOpen) useUiStore.getState().showToast(text, ok ? "info" : "error");
    if (typeof document !== "undefined" && !document.hasFocus()) {
      void notify(ok ? "✓ Un agente pasó la verificación" : "✗ Un agente no pasó la verificación", text);
    }
  } catch (err) {
    console.warn("[termCode] aviso de la carrera:", err);
  }
}

/** El agente terminó su turno (hook `Stop`): si es de la carrera, al juez. */
export function onAgentDone(paneId: string) {
  const entry = useRaceStore.getState().race?.entries.find((e) => e.paneId === paneId);
  if (entry) verifyEntry(entry.worktree);
}

/** Resumen para la cabecera: «2 de 3 pasaron». */
export function raceScore(entries: RaceEntry[]) {
  const judged = entries.filter((e) => e.verify.status === "done");
  return { total: entries.length, judged: judged.length, passed: judged.filter((e) => passed(e.verify)).length };
}

/**
 * Ya elegiste ganador: se cierran los agentes del resto y se borran sus
 * worktrees (y ramas). Antes de borrar un worktree se cierra su panel: nada
 * debe quedar corriendo dentro.
 */
export async function discardOthers(root: string, winner: string): Promise<number> {
  const race = useRaceStore.getState().race;
  if (!race) return 0;
  const losers = race.entries.filter((e) => e.worktree !== winner);
  const terminals = useTerminalStore.getState();
  losers.forEach((e) => terminals.closePane(e.paneId));
  let removed = 0;
  for (const loser of losers) {
    try {
      await gitApi.worktreeRemove(root, loser.worktree);
      removed++;
    } catch (err) {
      useUiStore.getState().showToast(`No se pudo borrar ${basename(loser.worktree)}: ${String(err)}`, "error");
    }
  }
  useRaceStore.getState().forget(losers.map((e) => e.worktree));
  return removed;
}
