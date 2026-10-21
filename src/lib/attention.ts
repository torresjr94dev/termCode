import type { Attention } from "../store/terminalStore";
import type { AgentActivity, AgentStatus, Tab } from "../types/layout";
import { collectPanes } from "./layout";

export interface PaneRef {
  tabId: string;
  paneId: string;
}

interface Candidate extends PaneRef {
  /** 0 = te necesita (permiso, pregunta), 1 = el resto (terminó, falló, campana). */
  rank: number;
  at: number;
}

/**
 * ⌘J: a quién atender ahora. Primero los que están bloqueados esperándote
 * (aprobación pendiente o pregunta), luego los que terminaron; dentro de cada
 * grupo, el que más lleva esperando. El panel en el que ya estás no cuenta.
 */
export function nextAttentionPane(
  tabs: Tab[],
  attention: Record<string, Attention>,
  activity: Record<string, AgentActivity>,
  currentPaneId: string | undefined,
  approvals: ReadonlyArray<{ paneId: string; at: number }> = [],
): PaneRef | null {
  const candidates: Candidate[] = [];
  for (const tab of tabs) {
    for (const pane of collectPanes(tab.root)) {
      if (pane.id === currentPaneId) continue;
      const approval = approvals.find((a) => a.paneId === pane.id);
      const seen = attention[pane.id];
      const blocked = activity[pane.id]?.state === "needs-input";
      if (approval || seen?.kind === "needs-input" || blocked) {
        const at = approval?.at ?? seen?.at ?? activity[pane.id]?.at ?? 0;
        candidates.push({ tabId: tab.id, paneId: pane.id, rank: 0, at });
      } else if (seen) {
        candidates.push({ tabId: tab.id, paneId: pane.id, rank: 1, at: seen.at });
      }
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || a.at - b.at);
  const first = candidates[0];
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
): AgentSummary {
  const summary: AgentSummary = { agents: 0, working: 0, waiting: 0, costUsd: null };
  for (const tab of tabs) {
    for (const pane of collectPanes(tab.root)) {
      if (!pane.agentType) continue;
      summary.agents++;
      const waiting =
        approvals.some((a) => a.paneId === pane.id) ||
        attention[pane.id]?.kind === "needs-input" ||
        activity[pane.id]?.state === "needs-input";
      if (waiting) summary.waiting++;
      else if (activity[pane.id]?.state === "working") summary.working++;
      const cost = status[pane.id]?.costUsd;
      if (cost != null) summary.costUsd = (summary.costUsd ?? 0) + cost;
    }
  }
  return summary;
}
