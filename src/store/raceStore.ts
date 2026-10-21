import { create } from "zustand";
import type { AgentKind } from "../types/layout";

/** Lo que dijo el juez (tu comando de verificación) sobre un worktree. */
export type VerifyState =
  | { status: "pending" }
  | { status: "queued" }
  | { status: "running"; startedAt: number }
  | { status: "done"; code: number | null; timedOut: boolean; output: string; durationMs: number; at: number }
  | { status: "error"; message: string; at: number };

export interface RaceEntry {
  paneId: string;
  agent: AgentKind;
  worktree: string;
  verify: VerifyState;
}

export interface Race {
  id: string;
  prompt: string;
  /** `pnpm test`, `cargo test`…; `null` = sin juez (comparas a ojo). */
  command: string | null;
  startedAt: number;
  entries: RaceEntry[];
}

interface RaceState {
  race: Race | null;
  start: (race: Race) => void;
  setVerify: (worktree: string, verify: VerifyState) => void;
  forget: (worktrees: string[]) => void;
  clear: () => void;
}

export const useRaceStore = create<RaceState>((set) => ({
  race: null,
  start: (race) => set({ race }),
  setVerify: (worktree, verify) =>
    set((state) =>
      state.race
        ? { race: { ...state.race, entries: state.race.entries.map((e) => (e.worktree === worktree ? { ...e, verify } : e)) } }
        : state,
    ),
  forget: (worktrees) =>
    set((state) => {
      if (!state.race) return state;
      const entries = state.race.entries.filter((e) => !worktrees.includes(e.worktree));
      return { race: entries.length ? { ...state.race, entries } : null };
    }),
  clear: () => set({ race: null }),
}));

export const passed = (v: VerifyState) => v.status === "done" && v.code === 0;
