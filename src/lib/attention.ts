import type { Attention } from "../store/terminalStore";
import type { AgentActivity, AgentKind, AgentStatus, PaneNode, Tab } from "../types/layout";
import { collectPanes } from "./layout";

export interface PaneRef {
  tabId: string;
  paneId: string;
}

export interface AttentionCandidate extends PaneRef {
  /** 0 = te necesita (permiso, pregunta), 1 = el resto (terminó, falló, campana). */
  rank: number;
  at: number;
}

export type AgentState = "working" | "needs-input" | "idle";

/** Programas que se anuncian por OSC 7501 y son agentes (Map: un `app` no puede ser `constructor`). */
const OSC_AGENTS = new Map<string, AgentKind>([
  ["claude-code", "claude"],
  ["codex", "codex"],
]);

/**
 * El agente del panel: el que lanzó termCode, el que se anunció por OSC 7501
 * o el que la shell dice que corre (`running`, de su integración). Un `claude`
 * escrito a mano también cuenta, sin esperar a que el agente se anuncie.
 */
export function paneAgent(pane: PaneNode, activity?: AgentActivity, running?: AgentKind | null): AgentKind | null {
  if (pane.agentType) return pane.agentType;
  const announced = activity?.source === "osc" && activity.app ? OSC_AGENTS.get(activity.app) : undefined;
  return announced ?? running ?? null;
}

/**
 * El estado de un agente en una sola regla para toda la interfaz (Mission
 * Control, barra lateral, barra de estado, campana). Manda lo que el agente
 * reporta ahora; la marca de atención "te necesita" solo cuenta si no hay
 * nada más (un aviso por OSC 9 de un agente sin hooks), porque una marca
 * vieja no puede contradecir a un agente que ya siguió trabajando.
 */
export function agentStateOf(activity: AgentActivity | undefined, attention: Attention | undefined, waitingApproval = false): AgentState {
  if (waitingApproval || activity?.state === "needs-input") return "needs-input";
  if (activity?.state === "working") return "working";
  if (!activity && attention?.kind === "needs-input") return "needs-input";
  return "idle";
}

/**
 * Todo lo que espera que lo atiendas, en el orden de ⌘J: primero los que están
 * bloqueados esperándote (aprobación pendiente o pregunta), luego los que
 * terminaron; dentro de cada grupo, el que más lleva esperando. El panel en el
 * que ya estás no cuenta.
 */
export function attentionCandidates(
  tabs: Tab[],
  attention: Record<string, Attention>,
  activity: Record<string, AgentActivity>,
  currentPaneId: string | undefined,
  approvals: ReadonlyArray<{ paneId: string; at: number }> = [],
): AttentionCandidate[] {
  const candidates: AttentionCandidate[] = [];
  for (const tab of tabs) {
    for (const pane of collectPanes(tab.root)) {
      if (pane.id === currentPaneId) continue;
      const approval = approvals.find((a) => a.paneId === pane.id);
      const seen = attention[pane.id];
      const live = activity[pane.id];
      if (agentStateOf(live, seen, Boolean(approval)) === "needs-input") {
        const at = approval?.at ?? (live?.state === "needs-input" ? live.at : seen?.at) ?? 0;
        candidates.push({ tabId: tab.id, paneId: pane.id, rank: 0, at });
      } else if (seen) {
        candidates.push({ tabId: tab.id, paneId: pane.id, rank: 1, at: seen.at });
      }
    }
  }
  return candidates.sort((a, b) => a.rank - b.rank || a.at - b.at);
}

/** ⌘J: a quién atender ahora (el primero de `attentionCandidates`). */
export function nextAttentionPane(...args: Parameters<typeof attentionCandidates>): PaneRef | null {
  const first = attentionCandidates(...args)[0];
  return first ? { tabId: first.tabId, paneId: first.paneId } : null;
}

export interface AgentSummary {
  agents: number;
  working: number;
  /** Bloqueados esperándote: aprobación pendiente o pregunta. */
  waiting: number;
  /** Suma del costo que reporta cada sesión de Claude; `null` si ninguna lo reporta. */
  costUsd: number | null;
}

export function agentSummary(
  tabs: Tab[],
  activity: Record<string, AgentActivity>,
  attention: Record<string, Attention>,
  status: Record<string, AgentStatus>,
  approvals: ReadonlyArray<{ paneId: string }> = [],
  running: Record<string, AgentKind> = {},
): AgentSummary {
  const summary: AgentSummary = { agents: 0, working: 0, waiting: 0, costUsd: null };
  for (const tab of tabs) {
    for (const pane of collectPanes(tab.root)) {
      if (!paneAgent(pane, activity[pane.id], running[pane.id])) continue;
      summary.agents++;
      const state = agentStateOf(activity[pane.id], attention[pane.id], approvals.some((a) => a.paneId === pane.id));
      if (state === "needs-input") summary.waiting++;
      else if (state === "working") summary.working++;
      const cost = status[pane.id]?.costUsd;
      if (cost != null) summary.costUsd = (summary.costUsd ?? 0) + cost;
    }
  }
  return summary;
}
