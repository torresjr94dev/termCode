/**
 * `.termcode.json`: los paneles de un proyecto ya armados (el servidor, los
 * tests, el agente). Lo que viene de un repo es ajeno hasta que lo apruebas:
 * aquí solo se valida la forma; quién confía en él lo decide `workspace.ts`.
 */

export const WORKSPACE_FILE = ".termcode.json";
export const MAX_PANES = 6;

export interface WorkspacePane {
  title?: string;
  /** Comando que se escribe en la shell del panel (queda en su historial). */
  run?: string;
  agent?: "claude" | "codex";
  /** Subcarpeta del repo (nunca fuera de él). */
  cwd?: string;
  /** Respecto al panel anterior; el primero es la pestaña. */
  split?: "right" | "down";
}

export interface Workspace {
  name: string;
  panes: WorkspacePane[];
}

export type ParseResult = { ok: true; workspace: Workspace } | { ok: false; error: string };

const isRelativeInside = (path: string) =>
  path.length < 512 && !/^(?:[\\/]|[A-Za-z]:)/.test(path) && !path.split(/[\\/]/).some((part) => part === "..");

/** Valida el archivo entero o lo rechaza con un motivo legible (nunca se ejecuta a medias). */
export function parseWorkspace(text: string, fallbackName: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${WORKSPACE_FILE} no es JSON válido.` };
  }
  const data = raw as { name?: unknown; panes?: unknown };
  if (!data || typeof data !== "object" || !Array.isArray(data.panes)) return { ok: false, error: `${WORKSPACE_FILE} necesita una lista "panes".` };
  if (!data.panes.length) return { ok: false, error: `${WORKSPACE_FILE} no tiene paneles.` };
  if (data.panes.length > MAX_PANES) return { ok: false, error: `Máximo ${MAX_PANES} paneles por workspace.` };
  const panes: WorkspacePane[] = [];
  for (const [i, value] of data.panes.entries()) {
    const p = value as Record<string, unknown>;
    const where = `Panel ${i + 1}`;
    if (!p || typeof p !== "object") return { ok: false, error: `${where}: debe ser un objeto.` };
    const pane: WorkspacePane = {};
    if (p.title !== undefined) {
      if (typeof p.title !== "string" || p.title.length > 40) return { ok: false, error: `${where}: "title" de hasta 40 caracteres.` };
      pane.title = p.title;
    }
    if (p.run !== undefined && p.agent !== undefined) return { ok: false, error: `${where}: "run" o "agent", no los dos.` };
    if (p.run !== undefined) {
      // Una línea: un salto de línea escondido ejecutaría un segundo comando sin que se vea en la confirmación.
      // eslint-disable-next-line no-control-regex -- rechazar controles es justo el objetivo
      if (typeof p.run !== "string" || !p.run.trim() || p.run.length > 500 || /[\r\n\u0000-\u0008\u000b-\u001f\u007f]/.test(p.run)) {
        return { ok: false, error: `${where}: "run" debe ser un solo comando de una línea.` };
      }
      pane.run = p.run.trim();
    }
    if (p.agent !== undefined) {
      if (p.agent !== "claude" && p.agent !== "codex") return { ok: false, error: `${where}: "agent" es "claude" o "codex".` };
      pane.agent = p.agent;
    }
    if (p.cwd !== undefined) {
      if (typeof p.cwd !== "string" || !isRelativeInside(p.cwd)) return { ok: false, error: `${where}: "cwd" es una subcarpeta del repo.` };
      pane.cwd = p.cwd.replace(/^\.\/?/, "");
    }
    if (p.split !== undefined) {
      if (p.split !== "right" && p.split !== "down") return { ok: false, error: `${where}: "split" es "right" o "down".` };
      if (i > 0) pane.split = p.split;
    }
    panes.push(pane);
  }
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 40) : fallbackName;
  return { ok: true, workspace: { name, panes } };
}

/** Plantilla para empezar (se copia al portapapeles). */
export const WORKSPACE_TEMPLATE = `${JSON.stringify(
  {
    name: "Mi proyecto",
    panes: [
      { title: "dev", run: "npm run dev" },
      { title: "tests", run: "npm test -- --watch", split: "right" },
      { agent: "claude", split: "down" },
    ],
  },
  null,
  2,
)}\n`;
