/**
 * Lo que el buscador (⌘P / ⌘⇧F) calcula sin tocar la interfaz: qué archivos
 * y carpetas caen en el alcance elegido, cómo se ordenan y las filas de los
 * resultados de texto.
 */
import { fuzzyFilter } from "./fuzzy";
import type { LineMatch, SearchResult } from "./git";

export interface FileQuery {
  text: string;
  line?: number;
  column?: number;
}

/** `App.tsx:120` (o `App.tsx:120:5`, como lo imprimen tsc y los linters) → buscar App.tsx e ir a esa línea. */
export function parseFileQuery(query: string): FileQuery {
  const match = /^(.*?):(\d+)(?::(\d+))?:?$/.exec(query.trim());
  if (!match || !match[1]) return { text: query.trim() };
  const line = Number(match[2]);
  const column = match[3] ? Number(match[3]) : undefined;
  return { text: match[1], line: line > 0 ? line : undefined, column: column && column > 0 ? column : undefined };
}

/** Carpetas que contienen a los archivos (`src/lib/a.ts` → `src` y `src/lib`), ordenadas. */
export function foldersOf(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let cut = file.indexOf("/"); cut !== -1; cut = file.indexOf("/", cut + 1)) dirs.add(file.slice(0, cut));
  }
  return [...dirs].sort();
}

const prefixOf = (dir: string) => (dir ? `${dir}/` : "");

/** La ruta vista desde la carpeta del alcance (lo que se compara y se muestra). */
export function relativeTo(path: string, dir: string): string {
  const prefix = prefixOf(dir);
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export interface FinderEntry {
  /** Relativa a la raíz del proyecto. */
  path: string;
  isDir: boolean;
}

export interface RankedEntry extends FinderEntry {
  /** Relativa al alcance (lo que se resalta). */
  shown: string;
  positions: number[];
  recent: boolean;
}

/** Bonos y castigos sobre la puntuación difusa. */
const RECENT_BONUS = 3;
const FOLDER_PENALTY = 4;

/**
 * Sin consulta: los recientes del alcance y luego el resto de archivos. Con
 * consulta: coincidencia difusa sobre la ruta relativa al alcance; las
 * carpetas también entran (un poco por detrás de los archivos).
 */
export function rankEntries(
  files: readonly string[],
  folders: readonly string[],
  dir: string,
  query: string,
  recents: readonly string[],
  limit: number,
): RankedEntry[] {
  const prefix = prefixOf(dir);
  const inScope = (path: string) => !prefix || path.startsWith(prefix);
  const recentSet = new Set(recents);
  const make = (path: string, isDir: boolean, positions: number[] = []): RankedEntry => ({
    path,
    isDir,
    shown: relativeTo(path, dir),
    positions,
    recent: recentSet.has(path),
  });

  if (!query.trim()) {
    // Solo los que siguen existiendo (uno borrado o de otra rama no se ofrece).
    const present = new Set(files);
    const recent = recents.filter((p) => inScope(p) && present.has(p)).map((p) => make(p, false));
    const rest: RankedEntry[] = [];
    for (const path of files) {
      if (rest.length + recent.length >= limit) break;
      if (inScope(path) && !recentSet.has(path)) rest.push(make(path, false));
    }
    return [...recent, ...rest].slice(0, limit);
  }

  const candidates: FinderEntry[] = [
    ...files.filter(inScope).map((path) => ({ path, isDir: false })),
    ...folders.filter((d) => inScope(d) && d !== dir).map((path) => ({ path, isDir: true })),
  ];
  // Se piden de más: los bonos pueden reordenar el final de la lista.
  const matches = fuzzyFilter(candidates, query, (e) => relativeTo(e.path, dir), limit * 2);
  return matches
    .map((m) => ({
      entry: make(m.item.path, m.item.isDir, m.positions),
      score: m.score + (recentSet.has(m.item.path) ? RECENT_BONUS : 0) - (m.item.isDir ? FOLDER_PENALTY : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.entry);
}

export type TextRow =
  | { kind: "file"; path: string; count: number; more: boolean }
  /** `index`: posición entre las filas elegibles (las de coincidencia). */
  | { kind: "match"; path: string; match: LineMatch; index: number };

/** Una cabecera por archivo y una fila por línea con coincidencias. */
export function textRows(result: Pick<SearchResult, "files"> | null): TextRow[] {
  const rows: TextRow[] = [];
  let index = 0;
  for (const file of result?.files ?? []) {
    rows.push({ kind: "file", path: file.path, count: file.matches.length, more: file.more });
    for (const match of file.matches) rows.push({ kind: "match", path: file.path, match, index: index++ });
  }
  return rows;
}

/** Trozos de una vista previa: lo que coincide va resaltado. */
export function splitByRanges(text: string, ranges: ReadonlyArray<readonly [number, number]>): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(start, at);
    if (end <= from) continue;
    if (from > at) parts.push({ text: text.slice(at, from), hit: false });
    parts.push({ text: text.slice(from, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}
