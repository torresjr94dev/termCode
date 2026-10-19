/**
 * Identidad de pestañas y paneles: un nombre útil cuando la shell solo dice
 * "zsh" o "usuario@host", y un color estable por proyecto.
 */
import type { PaneProject } from "../store/terminalStore";
import type { PaneNode, Tab } from "../types/layout";
import { findPane } from "./layout";

const SHELLS = /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|nu|pwsh|login|terminal)$/i;
const USER_AT_HOST = /^[\w.-]+@[\w.-]+/;

/** Usuario dueño de la carpeta (`/Users/x/…`, `/home/x/…`). */
function homeUser(cwd: string | undefined): string | null {
  const m = cwd?.match(/^\/(?:Users|home)\/([^/]+)/);
  return m ? m[1] : null;
}

/** El título no dice nada: nombre de la shell, `usuario@host…` o el propio usuario. */
export function isGenericTitle(title: string, cwd?: string): boolean {
  const t = title.trim();
  return !t || SHELLS.test(t) || USER_AT_HOST.test(t) || t === homeUser(cwd);
}

/** Nombre a mostrar de un panel: el título si dice algo; si no, el proyecto. */
export function paneDisplayName(pane: PaneNode, project?: PaneProject): string {
  if (pane.agentType || !project) return pane.title;
  return isGenericTitle(pane.title, project.cwd) ? project.name : pane.title;
}

/** Tonos cálidos (sin cian): definidos en index.css para cada tema. */
export const PROJECT_TONES = ["bg-proj-0", "bg-proj-1", "bg-proj-2", "bg-proj-3", "bg-proj-4", "bg-proj-5"] as const;

/** FNV-1a: el mismo proyecto da siempre el mismo tono, en cualquier sesión. */
export function projectTone(key: string): (typeof PROJECT_TONES)[number] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PROJECT_TONES[(hash >>> 0) % PROJECT_TONES.length];
}

/** `pnpm run dev --port 3000` → `pnpm run dev`. */
export function shortCommand(command: string, words = 3): string {
  const parts = command.split(/\s+/).filter(Boolean);
  const head = parts.slice(0, words).join(" ");
  return parts.length > words ? `${head} …` : head;
}

/** Nombre de la pestaña: el que le pusiste, o el de su panel activo. */
export function tabDisplayName(tab: Tab, projects: Record<string, PaneProject>): string {
  if (tab.customTitle) return tab.customTitle;
  const pane = findPane(tab.root, tab.activePaneId);
  return pane ? paneDisplayName(pane, projects[pane.id]) : tab.title;
}
