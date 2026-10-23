import { useSyncExternalStore } from "react";
import { terminalManager } from "./TerminalManager";
import type { CommandRecord } from "./commands";

const subscribeTracker = (paneId: string) => (listener: () => void) =>
  terminalManager.getTracker(paneId)?.subscribe(listener) ?? (() => {});

const trackerSubscriptions = new Map<string, (listener: () => void) => () => void>();

function subscriptionFor(paneId: string) {
  let subscribe = trackerSubscriptions.get(paneId);
  if (!subscribe) {
    subscribe = subscribeTracker(paneId);
    trackerSubscriptions.set(paneId, subscribe);
  }
  return subscribe;
}

/** Comando que corre ahora en el panel (integración con la shell), o null. */
export function useRunningCommand(paneId: string): string | null {
  return useSyncExternalStore(subscriptionFor(paneId), () => {
    const last = terminalManager.getTracker(paneId)?.last();
    return last && last.endedAt === null ? last.command.split("\n")[0].trim() || null : null;
  });
}

/**
 * Último comando del panel, corriendo o terminado. El registro se modifica en
 * su sitio al terminar: la suscripción va por la versión del tracker, no por
 * el objeto.
 */
export function useLastCommand(paneId: string): CommandRecord | null {
  useSyncExternalStore(subscriptionFor(paneId), () => terminalManager.getTracker(paneId)?.version ?? 0);
  return terminalManager.getTracker(paneId)?.last() ?? null;
}
