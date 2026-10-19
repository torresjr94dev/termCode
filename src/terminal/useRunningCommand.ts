import { useSyncExternalStore } from "react";
import { terminalManager } from "./TerminalManager";

const subscribeTracker = (paneId: string) => (listener: () => void) =>
  terminalManager.getTracker(paneId)?.subscribe(listener) ?? (() => {});

const trackerSubscriptions = new Map<string, (listener: () => void) => () => void>();

/** Comando que corre ahora en el panel (integración con la shell), o null. */
export function useRunningCommand(paneId: string): string | null {
  let subscribe = trackerSubscriptions.get(paneId);
  if (!subscribe) {
    subscribe = subscribeTracker(paneId);
    trackerSubscriptions.set(paneId, subscribe);
  }
  return useSyncExternalStore(subscribe, () => {
    const last = terminalManager.getTracker(paneId)?.last();
    return last && last.endedAt === null ? last.command.split("\n")[0].trim() || null : null;
  });
}
