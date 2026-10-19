import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "../lib/ipc";

/**
 * Rutas de archivo en la salida (`src/app.ts:42:7`, `./x.rs`, `/abs/y.md`,
 * `~/z.toml`) como enlaces. Solo se marcan las que existen de verdad.
 */

export interface PathMatch {
  /** Texto tal cual aparece (sin la posición). */
  path: string;
  line?: number;
  column?: number;
  /** Columna (0-based) donde empieza el match en la línea y su largo. */
  index: number;
  length: number;
}

// Inicio de línea o separador típico antes de una ruta; nunca después de "://".
const PATH_RE =
  /(?<=^|[\s'"`([{<=,])((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,12})(?::(\d+))?(?::(\d+))?/g;

export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const path = m[1];
    // Versiones (v24.12.0), IPs y extensiones numéricas no son archivos.
    if (/^v?\d+(\.\d+)+$/.test(path) || /\.\d+$/.test(path)) continue;
    if (!path.includes("/") && !/\.(\w+)$/.test(path)) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 3), m.index);
    if (before.endsWith("://")) continue;
    out.push({
      path,
      line: m[2] ? Number(m[2]) : undefined,
      column: m[3] ? Number(m[3]) : undefined,
      index: m.index ?? 0,
      length: m[0].length,
    });
  }
  return out;
}

export function resolvePath(path: string, cwd: string | null, home: string | null): string | null {
  if (path.startsWith("/")) return normalize(path);
  if (path.startsWith("~/")) return home ? normalize(`${home}/${path.slice(2)}`) : null;
  if (!cwd) return null;
  return normalize(`${cwd}/${path}`);
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Existencia de archivos con caché (la salida se repinta mucho). */
const existence = new Map<string, { ok: boolean; at: number }>();
const TTL_MS = 30_000;

async function existing(paths: string[]): Promise<Set<string>> {
  const now = Date.now();
  const unknown = paths.filter((p) => {
    const hit = existence.get(p);
    return !hit || now - hit.at > TTL_MS;
  });
  if (unknown.length && IS_TAURI) {
    try {
      const found = new Set(await invoke<string[]>("fs_existing_files", { paths: unknown }));
      unknown.forEach((p) => existence.set(p, { ok: found.has(p), at: now }));
    } catch {
      unknown.forEach((p) => existence.set(p, { ok: false, at: now }));
    }
  }
  return new Set(paths.filter((p) => existence.get(p)?.ok));
}

export interface FileLinkTarget {
  absolute: string;
  line?: number;
  column?: number;
}

export function fileLinkProvider(
  term: Terminal,
  context: () => { cwd: string | null; home: string | null },
  open: (target: FileLinkTarget, event: MouseEvent) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      const text = line?.translateToString(true) ?? "";
      const matches = text ? findPaths(text) : [];
      if (!matches.length) {
        callback(undefined);
        return;
      }
      const { cwd, home } = context();
      const resolved = matches
        .map((m) => ({ m, absolute: resolvePath(m.path, cwd, home) }))
        .filter((r): r is { m: PathMatch; absolute: string } => r.absolute !== null);

      void existing(resolved.map((r) => r.absolute)).then((ok) => {
        const links: ILink[] = resolved
          .filter((r) => ok.has(r.absolute))
          .map(({ m, absolute }) => ({
            text: text.slice(m.index, m.index + m.length),
            range: {
              start: { x: m.index + 1, y: bufferLineNumber },
              end: { x: m.index + m.length, y: bufferLineNumber },
            },
            decorations: { pointerCursor: true, underline: true },
            activate: (event: MouseEvent) => open({ absolute, line: m.line, column: m.column }, event),
          }));
        callback(links.length ? links : undefined);
      });
    },
  };
}
